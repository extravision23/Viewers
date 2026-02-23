const inFlightBySeries = new Map<string, Set<string>>();

export const isMprInFlight = (seriesInstanceUID?: string): boolean => {
  if (!seriesInstanceUID) {
    return false;
  }
  const planes = inFlightBySeries.get(seriesInstanceUID);
  return !!planes && planes.size > 0;
};

export const setMprInFlight = (seriesInstanceUID: string, plane: string, inFlight: boolean) => {
  if (!seriesInstanceUID) {
    return;
  }
  const key = plane?.toLowerCase?.() || 'unknown';
  if (inFlight) {
    let planes = inFlightBySeries.get(seriesInstanceUID);
    if (!planes) {
      planes = new Set<string>();
      inFlightBySeries.set(seriesInstanceUID, planes);
    }
    planes.add(key);
  } else {
    const planes = inFlightBySeries.get(seriesInstanceUID);
    if (!planes) {
      return;
    }
    planes.delete(key);
    if (planes.size === 0) {
      inFlightBySeries.delete(seriesInstanceUID);
    }
  }
};
