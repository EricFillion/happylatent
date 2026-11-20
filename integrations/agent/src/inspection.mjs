import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
const exec = promisify(execFile);
const LIMIT = 1800;
const MAX_IMAGES = 8;

async function run(binary, args) {
  try { return await exec(binary, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', windowsHide: true }); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Media inspection requires ffmpeg and ffprobe on the local MCP host PATH. Install FFmpeg, then restart the MCP client.');
    throw new Error(`Media inspection failed in ${binary}. The file may be unsupported, damaged, or exceed the two-minute processing limit.`);
  }
}
const input = path => ['-protocol_whitelist', 'file,pipe', '-i', path];
async function ffmpeg(args) { return run('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args]); }
function rate(value) { const [a,b=1] = String(value).split('/').map(Number); return b && Number.isFinite(a/b) ? a/b : null; }
function finite(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
export function sceneRanges(project) {
  if (!project) return [];
  let frame = 0;
  return project.scenes.map((scene, index) => {
    const start = frame / project.fps; frame += scene.durationFrames;
    return { sceneId: scene.id, name: scene.name || `Scene ${index + 1}`, start, end: frame / project.fps };
  });
}
export function sampleTimes(duration, scenes, count = 9, frameStep = 0.05) {
  const end = Math.max(0, duration - frameStep);
  const candidates = scenes.length ? scenes.flatMap(scene => [scene.start, (scene.start+scene.end)/2, Math.max(scene.start, scene.end-frameStep)]).filter(time => time <= end) : Array.from({length: count}, (_,i) => end*i/Math.max(1,count-1));
  const unique = [...new Set(candidates)];
  return unique.length <= count ? unique : Array.from({length: count}, (_,i) => unique[Math.round(i*(unique.length-1)/(count-1))]);
}

export class Inspection {
  constructor({ stateDir, resolveJob }) { this.stateDir = stateDir; this.resolveJob = resolveJob; }
  async source(jobId, kind) {
    const { result, project } = await this.resolveJob(jobId);
    if (!result.path || (kind === 'video' && result.mediaType !== 'video/mp4')) throw new Error('Select a completed video job for this inspection.');
    const info = await lstat(result.path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Inspection requires a regular owned result file.');
    const path = await realpath(result.path), root = await realpath(this.stateDir);
    const rel = relative(root,path);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Inspection result is outside the agent state directory.');
    const { stdout } = await run('ffprobe', ['-v','error', ...input(path), '-show_streams','-show_format','-of','json']);
    const probe = JSON.parse(stdout), video = probe.streams?.find(stream => stream.codec_type === 'video'), audio = probe.streams?.find(stream => stream.codec_type === 'audio');
    const duration = finite(probe.format?.duration);
    if (!(duration > 0 && duration <= LIMIT)) throw new Error(`Inspection supports finite media up to ${LIMIT} seconds.`);
    if (kind === 'video' && (!video || video.width*video.height > 4096*4096)) throw new Error('Unsupported video dimensions or missing video stream.');
    return { jobId, path, project, duration, video, audio, expected: result.expected, scenes: sceneRanges(project) };
  }
  async artifact(work) {
    const root = join(this.stateDir,'inspections'); await mkdir(root,{recursive:true,mode:0o700});
    const directory = await mkdtemp(join(root,'review-'));
    try {
      const output = await work(directory);
      output.report.reportPath = join(directory,'report.json');
      await writeFile(output.report.reportPath,JSON.stringify(output.report,null,2)+'\n',{mode:0o600});
      return output;
    } catch (error) { await rm(directory,{recursive:true,force:true}); throw error; }
  }
  async frame(source, timestamp, destination, size='768:432') {
    if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp >= source.duration) throw new Error('Frame timestamps must be within the video duration.');
    await ffmpeg([...input(source.path),'-ss',String(timestamp),'-map','0:v:0','-frames:v','1','-vf',`scale=${size}:force_original_aspect_ratio=decrease,pad=${size}:(ow-iw)/2:(oh-ih)/2`, destination]);
    if (!(await lstat(destination).catch(() => ({size:0}))).size) throw new Error('No frame exists at the requested timestamp.');
    return { timestampRequested: timestamp, scene: source.scenes.find(scene => timestamp >= scene.start && timestamp < scene.end), path: destination };
  }
  async sheet(source, times, directory, prefix) {
    for (let i=0;i<times.length;i++) await this.frame(source,times[i],join(directory,`${prefix}-${i}.png`),'320:180');
    const destination = join(directory,`${prefix}.png`);
    await ffmpeg(['-framerate','1','-i',join(directory,`${prefix}-%d.png`),'-vf',`tile=3x${Math.ceil(times.length/3)}:nb_frames=${times.length}:padding=4:margin=4:color=black`,'-frames:v','1',destination]);
    return { path: destination, panels: times.map((timestampRequested,index)=>({panel:index+1,timestampRequested,scene:source.scenes.find(scene=>timestampRequested>=scene.start&&timestampRequested<scene.end)})) };
  }
  async video({jobId, samples=9}) {
    if (!Number.isInteger(samples)||samples<3||samples>12) throw new Error('Use 3–12 contact-sheet samples.');
    const source = await this.source(jobId,'video');
    return this.artifact(async directory => {
      const sheet = await this.sheet(source,sampleTimes(source.duration,source.scenes,samples,1/(rate(source.video.avg_frame_rate)||1)),directory,'contact-sheet');
      const expectedDuration = source.expected?.frames / source.expected?.fps;
      return { report: { jobId, durationSeconds:source.duration, width:source.video.width,height:source.video.height,averageFps:rate(source.video.avg_frame_rate),hasAudio:!!source.audio,scenes:source.scenes,contactSheet:sheet,
        ...(Number.isFinite(expectedDuration)?{expectedDurationSeconds:expectedDuration,durationDifferenceSeconds:source.duration-expectedDuration}:{}),
        limitations:'Panels are in row-major order; timestamps are requested seek times. Sparse stills cannot establish motion quality, lip-sync, or overall quality. Long projects may omit scenes; use get_video_frames for closer inspection.' }, images:[sheet.path] };
    });
  }
  async frames({jobId,timestamps}) {
    if (!Array.isArray(timestamps)||timestamps.length<1||timestamps.length>MAX_IMAGES) throw new Error('Request 1–8 timestamps.');
    const source = await this.source(jobId,'video');
    return this.artifact(async directory=> {
      const frames=[];
      for(const [i,time] of timestamps.entries()) frames.push(await this.frame(source,time,join(directory,`frame-${i}.png`)));
      return {report:{jobId,frames,note:'Accurate seeks return the first available frame at/after each requested time, resized to fit 768×432. These are still-image observations.'},images:frames.map(frame=>frame.path)};
    });
  }
  async compare({jobIds,sceneId}) {
    if (!Array.isArray(jobIds)||jobIds.length!==2||jobIds[0]===jobIds[1]) throw new Error('Select two different completed video job IDs.');
    const sources=[]; for(const id of jobIds) sources.push(await this.source(id,'video'));
    const ranges=sources.map(source=>sceneId?source.scenes.find(scene=>scene.sceneId===sceneId):{start:0,end:source.duration});
    if(ranges.some(range=>!range)) throw new Error('The scene ID must exist in both saved project revisions.');
    return this.artifact(async directory=> {
      const sheets=[];
      for(const [i,source] of sources.entries()) {
        const range=ranges[i]; const times=[0,0.5,1].map(f=>range.start+f*Math.max(0,Math.min(range.end,source.duration)-range.start-1/(rate(source.video.avg_frame_rate)||1)));
        sheets.push({jobId:source.jobId,...await this.sheet(source,times,directory,`version-${i+1}`)});
      }
      return {report:{sceneId,versions:sheets,alignment:'Start, middle and end of each selected scene or video, matched by relative position. Different durations do not imply identical action timing. No automatic quality winner is assigned.'},images:sheets.map(sheet=>sheet.path)};
    });
  }
  async audio({jobId}) {
    const source=await this.source(jobId,'audio');
    if(!source.audio) return {report:{jobId,hasAudio:false,findings:['No audio stream. This may be intentional.']},images:[]};
    return this.artifact(async directory=> {
      const waveform=join(directory,'waveform.png');
      await ffmpeg([...input(source.path),'-filter_complex','[0:a:0]showwavespic=s=1200x240:split_channels=1:colors=0x59b8ff[v]','-map','[v]','-frames:v','1',waveform]);
      // FFmpeg emits bounded text measurements; no raw audio or extra model is sent to the client.
      const {stderr}=await run('ffmpeg',['-hide_banner','-nostdin','-v','info',...input(source.path),'-map','0:a:0','-vn','-af','silencedetect=noise=-50dB:d=0.25,volumedetect','-f','null','-']);
      const intervals=[]; let start;
      for(const line of stderr.split('\n')) {
        const begin=line.match(/silence_start: ([\d.]+)/), end=line.match(/silence_end: ([\d.]+)/);
        if(begin) start=Number(begin[1]);
        if(end && start!==undefined) {intervals.push({start,end:Number(end[1])});start=undefined;}
      }
      if(start!==undefined) intervals.push({start,end:source.duration});
      const db=name=>{const match=stderr.match(new RegExp(`${name}: (-?[\\d.]+|inf|-inf) dB`));return match&&Number.isFinite(Number(match[1]))?Number(match[1]):null;};
      const peak=db('max_volume'), mean=db('mean_volume');
      return {report:{jobId,hasAudio:true,durationSeconds:source.duration,sampleRate:finite(source.audio.sample_rate),channels:source.audio.channels,peakDbfs:peak,meanDbfs:mean,possibleClipping:peak!==null&&peak>=-0.1,silenceThresholdDbfs:-50,minimumSilenceSeconds:0.25,silentIntervals:intervals,waveformPath:waveform,
        limitations:'Measurements use FFmpeg volumedetect (16-bit sample conversion). Near-full-scale peaks suggest possible clipping, not proof. Silence can be intentional. Waveforms do not establish speech accuracy, voice quality, clicks, or lip-sync; no listening or transcription was performed.'},images:[waveform]};
    });
  }
}

export async function inspectionContent(output) {
  const content=[{type:'text',text:JSON.stringify(output.report)}];
  let totalBytes = 0;
  for(const path of output.images) {
    const data=await readFile(path);
    totalBytes += data.length;
    if(data.length>4*1024*1024 || totalBytes>8*1024*1024) throw new Error('Inspection image exceeds the inline size limit.');
    content.push({type:'image',mimeType:'image/png',data:data.toString('base64')});
  }
  return {content,structuredContent:output.report};
}
