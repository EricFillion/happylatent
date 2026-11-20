export const RUNPOD_STORAGE_REMINDER = 'Storage can still incur charges after the GPU stops. Save your results, then terminate the Pod when you no longer need its volume disk. When you are done with any separately created volume and its cached files, delete it under Runpod Persistent Storage (https://console.runpod.io/user/storage).';

const launchWarning = 'If you close this chat or setup is interrupted, check Runpod Pods (https://console.runpod.io/pods) and stop the Happy Latent Pod if it is still running. An interruption before the automatic shutdown timer starts can leave the GPU running.';

export function runpodStorageReminder({ containerDiskGb } = {}) {
  return containerDiskGb
    ? 'Stopping or restarting the Pod erases the temporary container disk, including models and cloud outputs. Retrieve results before shutdown. Container disk charges end when the Pod stops.'
    : RUNPOD_STORAGE_REMINDER;
}

export function runpodLaunchWarning(lease) {
  return `${launchWarning} ${runpodStorageReminder(lease)}`;
}

export const RUNPOD_LAUNCH_WARNING = runpodLaunchWarning();
