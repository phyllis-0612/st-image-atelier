export function normalizeBackupSettings(value = {}) {
  const seconds = Number(value.backupWaitSeconds);
  return {
    enableBackupPreset: value.enableBackupPreset === true,
    backupPresetId: String(value.backupPresetId || '').trim(),
    backupWaitSeconds: Number.isFinite(seconds) && seconds >= 1
      ? Math.min(86400, Math.floor(seconds)) : 180,
  };
}
