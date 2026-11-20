// Decimal GB, matching the model manifest and provider volume sizes.
export const DEFAULT_VOLUME_GB = 100;
export const DEFAULT_CONTAINER_DISK_GB = 40;
export const TEMPORARY_CONTAINER_DISK_GB = 120;
export const WORKSPACE_MOUNT_PATH = '/workspace';
const GB = 1e9;
const RESERVE = 10 * GB;
const MINIMUM_FREE = 2 * GB;

export function assessStorage(snapshot, { now = Date.now(), requiredFreeGb = 0 } = {}) {
  if (!Number.isFinite(requiredFreeGb) || requiredFreeGb < 0 || requiredFreeGb > 1e6) {
    throw new Error('requiredFreeGb must be a finite number from 0 to 1000000.');
  }
  const unavailable = reason => ({ status: 'unavailable', reason,
    recommendation: 'Reconnect or update the cloud runtime and check storage before a large batch. No capacity estimate is available.' });
  if (!snapshot || snapshot.status !== 'measured') return unavailable('The cloud runtime did not report filesystem capacity.');
  const { totalBytes, freeBytes, measuredAt } = snapshot;
  if (![totalBytes, freeBytes].every(Number.isSafeInteger) || totalBytes <= 0 || freeBytes < 0 || freeBytes > totalBytes) {
    return unavailable('The cloud runtime returned invalid filesystem capacity.');
  }
  const age = now - Date.parse(measuredAt);
  if (!Number.isFinite(age) || age < -30_000 || age > 60_000) return unavailable('The filesystem capacity measurement is stale.');
  const usedBytes = totalBytes - freeBytes;
  const requiredBytes = Math.ceil(requiredFreeGb * GB);
  const projectedFree = freeBytes - requiredBytes;
  const fraction = usedBytes / totalBytes;
  const status = (usedBytes + requiredBytes) / totalBytes >= 0.9 || projectedFree < RESERVE ? 'critical'
    : fraction >= 0.8 || (usedBytes + requiredBytes) / totalBytes >= 0.8 ? 'warning' : 'ok';
  const report = { status, path: '/workspace', measuredAt, totalBytes, usedBytes, freeBytes,
    totalGb: totalBytes / GB, usedGb: usedBytes / GB, freeGb: freeBytes / GB,
    usedPercent: Math.round(fraction * 1000) / 10, requiredFreeGb,
    reserveGb: RESERVE / GB, canStartWrite: projectedFree >= MINIMUM_FREE,
    measurement: 'Filesystem-reported capacity for the whole /workspace volume, including models, environments, caches, media and other files. Free space is available to the renderer; reserved blocks count as unavailable. Not a provider billing or quota read.' };
  if (status !== 'ok') {
    const suggestedVolumeGb = Math.ceil(Math.max(totalBytes / GB + 50, (usedBytes + requiredBytes + RESERVE) / GB / 0.7) / 50) * 50;
    report.recommendation = { action: 'increase_volume', suggestedVolumeGb,
      message: `Cloud storage is ${(fraction * 100).toFixed(1)}% used: ${(freeBytes / GB).toFixed(1)} GB free of ${(totalBytes / GB).toFixed(1)} GB. Recommend at least ${suggestedVolumeGb} GB${requiredFreeGb ? ` for the requested ${requiredFreeGb} GB of additional space` : ''}. Verify the volume and current resize price with Runpod; obtain spending approval before increasing it.`,
      automaticResize: false,
      alternative: 'Offer cleanup of retrieved cloud media using cloud_data_inventory and cloud_cleanup. Never delete models, takes or provider storage automatically.' };
  }
  return report;
}

export function requireStorageSpace(report) {
  if (report.status !== 'unavailable' && report.canStartWrite === false) {
    throw new Error(`Insufficient cloud storage: retain at least 2 GB free after the planned write. ${report.recommendation.message} Existing jobs are not cancelled; results can still be retrieved.`);
  }
}
