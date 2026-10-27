/** Match the compiler's stable expansion keys, never a displayed parent ID. */
function stageFor(member, id) {
    const direct = member.stages.get(id);
    if (direct)
        return { text: direct };
    if (!id.startsWith(`${member.id}.`))
        return;
    const key = /^\d+\.\d+\.(.+)$/.exec(id.slice(member.id.length + 1))?.[1];
    if (!key)
        return;
    if (key === "sequence")
        return { text: "Assembling video" };
    if (key === "soundtrack")
        return { text: "Assembling audio" };
    const scene = /^scene_(\d+)_(.+)$/.exec(key);
    if (!scene)
        return { text: "Preparing generation" };
    const index = Number(scene[1]);
    if (index >= member.scenes)
        return;
    const operation = scene[2];
    const label = operation === "sample" ? "Generating video"
        : operation === "positive" ? "Encoding prompt"
            : operation === "decode" ? "Decoding video"
                : operation === "audio_decode" ? "Decoding audio"
                    : ["trim", "video", "separate", "crop_guides"].includes(operation) ? "Preparing video"
                        : operation.includes("image") || operation.includes("crop") || operation === "end_frame" ? "Preparing reference images"
                            : operation.includes("audio") ? "Preparing audio" : "Preparing clip";
    return { text: `Clip ${index + 1} of ${member.scenes} · ${label}`, sampling: operation === "sample" };
}
function links(node) {
    return Object.values(node.inputs).flatMap(value => Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]) ? [value[0]] : []);
}
/** Resolve flattened subgraph execution IDs against the root graph at submission. */
export function executionNode(root, id) {
    let graph = root;
    const path = id.split(":");
    for (let index = 0; index < path.length; index++) {
        const nodes = graph?.nodes ?? graph?._nodes ?? [];
        const node = Array.from(nodes).find(node => String(node.id) === path[index]);
        if (!node)
            return;
        if (index === path.length - 1)
            return node;
        graph = node.subgraph;
    }
}
/** One observer per mounted editor; no project mutations, timing estimates or queue of our own. */
export function createGenerationTracker(api, resolveNode) {
    const observers = new Set();
    const jobs = new Map();
    // WebSocket execution can beat the POST response. Retain only recent event types
    // while submissions are in flight, then replay against their exact prompt IDs.
    const early = new Map();
    let pending = 0;
    let eventOrder = 0;
    let disposed = false;
    function emit(member, promptId, status) {
        const observer = member.observer;
        if (!observer.active || observer.promptId !== promptId)
            return;
        observer.update(status);
    }
    function snapshot(prompt, targets) {
        if (!prompt || typeof prompt !== "object")
            return [];
        const dependencies = new Map();
        for (const [id, node] of Object.entries(prompt))
            dependencies.set(id, links(node));
        function ancestors(id) {
            const found = new Set(), pending = [...dependencies.get(id) ?? []];
            while (pending.length) {
                const next = pending.pop();
                if (found.has(next))
                    continue;
                found.add(next);
                pending.push(...dependencies.get(next) ?? []);
            }
            return found;
        }
        const selected = Array.isArray(targets) ? new Set(targets.flatMap(id => [id, ...ancestors(id)])) : undefined;
        const result = [];
        for (const [id, node] of Object.entries(prompt)) {
            if (node.class_type !== "HappyLatentVideo")
                continue;
            if (selected && !selected.has(id))
                continue;
            const owner = resolveNode(id);
            const observer = [...observers].find(item => item.node === owner);
            if (!observer)
                continue;
            let scenes;
            try {
                scenes = JSON.parse(String(node.inputs.project)).scenes.length;
            }
            catch {
                continue;
            }
            if (!Number.isInteger(scenes) || scenes < 1 || scenes > 100)
                continue;
            const stages = new Map([[id, "Preparing generation"]]);
            let expected = !!selected;
            for (const upstream of ancestors(id)) {
                stages.set(upstream, /Loader|Checkpoint/.test(prompt[upstream]?.class_type ?? "") ? "Preparing models" : "Preparing inputs");
            }
            for (const [downstream, output] of Object.entries(prompt)) {
                if (downstream !== id && ancestors(downstream).has(id)) {
                    if (selected && !selected.has(downstream))
                        continue;
                    stages.set(downstream, output.class_type === "SaveVideo" ? "Saving video" : "Processing output");
                    if (output.class_type === "SaveVideo")
                        expected = true;
                }
            }
            result.push({ observer, id, scenes, expected, stages });
        }
        return result;
    }
    function finish(id, job, status) {
        for (const member of job.members)
            emit(member, id, status);
        jobs.delete(id);
    }
    function show(member, promptId, nodeId, value, max, actualProgress = false) {
        const stage = stageFor(member, nodeId);
        if (!stage)
            return;
        // The expanding parent remains running while all its children execute.
        if (nodeId === member.id && member.current && member.current !== nodeId)
            return;
        let text = stage.text;
        if (stage.sampling && typeof value === "number" && typeof max === "number"
            && Number.isInteger(value) && Number.isInteger(max) && max > 0 && value >= 0 && value <= max
            && (actualProgress || value > 0))
            text += ` · Step ${value} of ${max}`;
        // A synthetic 0/1 state must not erase actual sampler counts for this node.
        if (member.current === nodeId && stage.sampling && value === 0 && max === 1 && member.text?.includes(" · Step "))
            text = member.text;
        member.current = nodeId;
        member.text = text;
        emit(member, promptId, { text, state: "running" });
    }
    function activate(member, id, order) {
        if (member.observer.order > order)
            return;
        member.observer.order = order;
        member.observer.promptId = id;
        emit(member, id, { text: "Preparing generation", state: "running" });
    }
    function receive(type, data, order = ++eventOrder) {
        const id = data?.prompt_id;
        if (typeof id !== "string")
            return;
        const job = jobs.get(id);
        if (!job) {
            if (pending) {
                let events = early.get(id);
                if (!events) {
                    events = new Map();
                    early.set(id, events);
                }
                const key = type === "executed" ? `${type}:${data.node}` : type;
                events.delete(key);
                events.set(key, [type, data, order]);
                if (events.size > 64)
                    events.delete(events.keys().next().value);
                if (early.size > 16)
                    early.delete(early.keys().next().value);
            }
            return;
        }
        if (!job.started) {
            job.started = true;
            job.order = order;
            for (const member of job.members)
                if (member.expected)
                    activate(member, id, order);
        }
        job.disconnected = false;
        if (type === "execution_success")
            return finish(id, job, { text: "Complete", state: "complete" });
        if (type === "execution_error")
            return finish(id, job, { text: "Generation failed · See ComfyUI error details", state: "error" });
        if (type === "execution_interrupted")
            return finish(id, job, { text: "Generation cancelled", state: "interrupted" });
        if (type === "progress_state" && data.nodes && typeof data.nodes === "object") {
            for (const member of job.members) {
                if (!member.expected) {
                    const own = Object.entries(data.nodes).some(([key, state]) => state.state === "running" && (key === member.id || key.startsWith(`${member.id}.`)) && stageFor(member, key));
                    if (!own)
                        continue;
                    member.expected = true;
                    activate(member, id, job.order);
                }
                const running = Object.entries(data.nodes).filter(([key, state]) => state.state === "running" && stageFor(member, key));
                const current = running.filter(([key]) => key !== member.id).at(-1) ?? running.at(-1);
                if (current)
                    show(member, id, current[0], current[1].value, current[1].max);
            }
        }
        else if (type === "progress" && typeof data.node === "string") {
            for (const member of job.members) {
                if (member.current === data.node)
                    show(member, id, data.node, data.value, data.max, true);
            }
        }
        else if (type === "executed") {
            for (const member of job.members) {
                if (member.stages.get(data.node) === "Saving video")
                    emit(member, id, { text: "Video saved · Finishing workflow", state: "running" });
            }
        }
    }
    const listeners = new Map();
    for (const type of ["execution_start", "execution_cached", "progress_state", "progress", "executed", "execution_success", "execution_error", "execution_interrupted"]) {
        listeners.set(type, event => receive(type, event.detail));
    }
    listeners.set("reconnecting", () => {
        for (const [id, job] of jobs)
            if (job.started) {
                job.disconnected = true;
                for (const member of job.members)
                    emit(member, id, { text: "Connection lost · Generation status unavailable", state: "unknown" });
            }
    });
    listeners.set("reconnected", () => {
        for (const [id, job] of jobs)
            if (job.disconnected) {
                for (const member of job.members)
                    emit(member, id, { text: "Reconnected · Waiting for generation status", state: "unknown" });
                // The server's reconnect executing event has only a display ID. History is
                // the only trustworthy way to recover completion missed while disconnected.
                if (api.fetchApi)
                    void api.fetchApi(`/history/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) }).then(async (response) => {
                        if (!response.ok)
                            return;
                        const history = (await response.json())[id];
                        if (disposed || jobs.get(id) !== job || !job.disconnected)
                            return;
                        if (history?.status?.completed && history.status.status_str === "success")
                            finish(id, job, { text: "Complete", state: "complete" });
                        else if (history?.status?.messages?.some((entry) => entry[0] === "execution_interrupted"))
                            finish(id, job, { text: "Generation cancelled", state: "interrupted" });
                        else if (history?.status?.status_str === "error")
                            finish(id, job, { text: "Generation failed · See ComfyUI error details", state: "error" });
                    }).catch(() => { });
            }
    });
    for (const [type, listener] of listeners)
        api.addEventListener(type, listener);
    const originalQueue = api.queuePrompt;
    const wrappedQueue = async function (...args) {
        // Instrumentation must never prevent a valid host queue request.
        let members = [];
        try {
            members = snapshot(args[1]?.output, args[2]?.partialExecutionTargets);
        }
        catch { /* Unsupported prompt shape. */ }
        pending++;
        try {
            const response = await originalQueue.apply(this, args);
            const id = response?.prompt_id;
            if (!disposed && typeof id === "string" && members.length) {
                jobs.set(id, { members, started: false, disconnected: false, order: 0 });
                // Bound retained snapshots if queued jobs are removed through ComfyUI.
                if (jobs.size > 128) {
                    const inactive = [...jobs].find(([, job]) => !job.started)?.[0];
                    if (inactive)
                        jobs.delete(inactive);
                }
                for (const [type, detail, order] of early.get(id)?.values() ?? [])
                    receive(type, detail, order);
            }
            return response;
        }
        finally {
            pending--;
            if (!pending)
                early.clear();
        }
    };
    api.queuePrompt = wrappedQueue;
    return {
        watch(node, update) {
            const observer = { node, update, active: true, order: 0 };
            observers.add(observer);
            return () => { observer.active = false; observers.delete(observer); };
        },
        dispose() {
            disposed = true;
            for (const observer of observers)
                observer.active = false;
            observers.clear();
            jobs.clear();
            early.clear();
            for (const [type, listener] of listeners)
                api.removeEventListener(type, listener);
            if (api.queuePrompt === wrappedQueue)
                api.queuePrompt = originalQueue;
        },
    };
}
//# sourceMappingURL=generation-status.js.map