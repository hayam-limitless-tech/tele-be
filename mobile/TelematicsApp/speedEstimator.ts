export type LocationReading = {
  latitude: number;
  longitude: number;
  time: number;
  accuracy?: number | null;
  coordsSpeedMps?: number | null;
  speedAccuracyMps?: number | null;
};

export type SpeedHistorySample = {
  latitude: number;
  longitude: number;
  time: number;
  accuracy: number;
  estimatedSpeedKmh: number;
  sensorSpeedKmh: number | null;
  reliable: boolean;
};

export type TripLocationPoint = {
  latitude: number;
  longitude: number;
  time: number;
  speed: number;
  accuracy: number;
  reliable: boolean;
};

export type SpeedEstimateResult = {
  estimatedSpeedKmh: number;
  displaySpeedKmh: number;
  sensorSpeedKmh: number | null;
  instantDistanceSpeedKmh: number | null;
  windowSpeedKmh: number | null;
  distanceFromPreviousMeters: number;
  isReliable: boolean;
  isMoving: boolean;
  nextHistory: SpeedHistorySample[];
};

const HISTORY_WINDOW_MS = 15_000;
const WINDOW_LOOKBACK_MS = 4_500;
const MIN_WINDOW_MS = 2_500;
const MAX_SEGMENT_GAP_MS = 15_000;
const RELIABLE_ACCURACY_METERS = 25;
const USABLE_ACCURACY_METERS = 45;
const MIN_MOVING_SPEED_KMH = 2.5;
const MAX_REASONABLE_SPEED_KMH = 180;
const MAX_ACCELERATION_KMH_PER_SEC = 12;

function asFiniteNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeAccuracy(accuracy: number | null | undefined): number {
  const value = asFiniteNumber(accuracy);
  return value != null && value > 0 ? value : 999;
}

function metersToKmh(distanceMeters: number, timeMs: number): number {
  if (!Number.isFinite(distanceMeters) || !Number.isFinite(timeMs) || timeMs <= 0) return 0;
  return (distanceMeters / timeMs) * 3600;
}

function toKmh(speedMps: number | null | undefined): number | null {
  const value = asFiniteNumber(speedMps);
  if (value == null || value < 0) return null;
  return value * 3.6;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function noiseFloorMeters(...accuracies: number[]): number {
  const usable = accuracies.filter((value) => Number.isFinite(value) && value > 0);
  const maxAccuracy = usable.length > 0 ? Math.max(...usable) : RELIABLE_ACCURACY_METERS;
  return Math.max(maxAccuracy * 0.55, 5);
}

function pickWindowSample(history: SpeedHistorySample[], currentTime: number): SpeedHistorySample | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const sample = history[i];
    const deltaMs = currentTime - sample.time;
    if (deltaMs >= MIN_WINDOW_MS && deltaMs <= WINDOW_LOOKBACK_MS * 1.6) {
      return sample;
    }
  }
  return null;
}

function trimHistory(history: SpeedHistorySample[], currentTime: number): SpeedHistorySample[] {
  return history.filter((sample) => currentTime - sample.time <= HISTORY_WINDOW_MS);
}

function clusterRadiusMeters(
  history: SpeedHistorySample[],
  currentLatitude: number,
  currentLongitude: number,
  currentTime: number
): number {
  const recent = history.filter((sample) => currentTime - sample.time <= 6_000);
  if (recent.length === 0) return 0;

  let maxDistanceMeters = 0;
  for (const sample of recent) {
    const distanceMeters = distanceKm(
      currentLatitude,
      currentLongitude,
      sample.latitude,
      sample.longitude
    ) * 1000;
    if (distanceMeters > maxDistanceMeters) {
      maxDistanceMeters = distanceMeters;
    }
  }

  return maxDistanceMeters;
}

export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const earthRadiusKm = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

export function updateSpeedEstimate(
  history: SpeedHistorySample[],
  reading: LocationReading,
  previousDisplaySpeedKmh: number
): SpeedEstimateResult {
  const accuracy = normalizeAccuracy(reading.accuracy);
  const sensorSpeedKmh = toKmh(reading.coordsSpeedMps);
  const speedAccuracyKmh = toKmh(reading.speedAccuracyMps);
  const stableHistory = trimHistory(history, reading.time);
  const previousSample = stableHistory.length > 0 ? stableHistory[stableHistory.length - 1] : null;

  let deltaTimeMs = 0;
  let distanceFromPreviousMeters = 0;
  let instantDistanceSpeedKmh: number | null = null;

  if (previousSample) {
    deltaTimeMs = reading.time - previousSample.time;
    distanceFromPreviousMeters =
      distanceKm(
        previousSample.latitude,
        previousSample.longitude,
        reading.latitude,
        reading.longitude
      ) * 1000;

    if (deltaTimeMs >= 900 && deltaTimeMs <= MAX_SEGMENT_GAP_MS) {
      instantDistanceSpeedKmh = metersToKmh(distanceFromPreviousMeters, deltaTimeMs);
    }
  }

  const windowSample = pickWindowSample(stableHistory, reading.time);
  const windowDistanceMeters = windowSample
    ? distanceKm(windowSample.latitude, windowSample.longitude, reading.latitude, reading.longitude) * 1000
    : 0;
  const windowTimeMs = windowSample ? reading.time - windowSample.time : 0;
  const windowSpeedKmh =
    windowSample && windowTimeMs >= MIN_WINDOW_MS ? metersToKmh(windowDistanceMeters, windowTimeMs) : null;

  const clusterMeters = clusterRadiusMeters(stableHistory, reading.latitude, reading.longitude, reading.time);
  const stationaryNoiseFloorMeters = noiseFloorMeters(
    accuracy,
    windowSample?.accuracy ?? accuracy,
    previousSample?.accuracy ?? accuracy
  );

  const stationaryByWindow =
    windowSpeedKmh != null &&
    windowSpeedKmh < 3.5 &&
    clusterMeters <= Math.max(stationaryNoiseFloorMeters, 6);

  const reliableSensor =
    sensorSpeedKmh != null &&
    sensorSpeedKmh <= MAX_REASONABLE_SPEED_KMH &&
    (speedAccuracyKmh == null || speedAccuracyKmh <= 18);

  const sensorConsistentWithWindow =
    sensorSpeedKmh == null ||
    windowSpeedKmh == null ||
    Math.abs(sensorSpeedKmh - windowSpeedKmh) <= Math.max(8, windowSpeedKmh * 0.8);

  const sensorConsistentWithInstant =
    sensorSpeedKmh == null ||
    instantDistanceSpeedKmh == null ||
    Math.abs(sensorSpeedKmh - instantDistanceSpeedKmh) <= Math.max(10, sensorSpeedKmh * 0.8);

  const goodAccuracy = accuracy <= RELIABLE_ACCURACY_METERS;
  const usableAccuracy = accuracy <= USABLE_ACCURACY_METERS;

  let estimatedSpeedKmh = 0;
  let isReliable = false;

  if (stationaryByWindow && (!reliableSensor || (sensorSpeedKmh ?? 0) <= 12)) {
    estimatedSpeedKmh = 0;
    isReliable = true;
  } else if (reliableSensor && usableAccuracy && sensorConsistentWithWindow && windowSpeedKmh != null) {
    estimatedSpeedKmh = sensorSpeedKmh! * 0.6 + windowSpeedKmh * 0.4;
    isReliable = true;
  } else if (
    reliableSensor &&
    goodAccuracy &&
    sensorConsistentWithInstant &&
    instantDistanceSpeedKmh != null
  ) {
    estimatedSpeedKmh = sensorSpeedKmh! * 0.65 + instantDistanceSpeedKmh * 0.35;
    isReliable = true;
  } else if (windowSpeedKmh != null && usableAccuracy) {
    estimatedSpeedKmh = windowSpeedKmh;
    isReliable = true;
  } else if (instantDistanceSpeedKmh != null && goodAccuracy) {
    estimatedSpeedKmh = instantDistanceSpeedKmh;
    isReliable = true;
  } else if (reliableSensor && goodAccuracy && sensorSpeedKmh! <= 12) {
    estimatedSpeedKmh = sensorSpeedKmh!;
    isReliable = true;
  } else if (reliableSensor && speedAccuracyKmh != null && speedAccuracyKmh <= 6) {
    estimatedSpeedKmh = sensorSpeedKmh!;
    isReliable = true;
  }

  const previousEstimatedSpeedKmh = previousSample?.estimatedSpeedKmh ?? 0;
  if (isReliable && deltaTimeMs > 0) {
    const deltaTimeSec = deltaTimeMs / 1000;
    const maxRise = previousEstimatedSpeedKmh + deltaTimeSec * MAX_ACCELERATION_KMH_PER_SEC + 5;
    const corroboratedByDistance =
      (windowSpeedKmh != null && windowSpeedKmh > previousEstimatedSpeedKmh) ||
      (instantDistanceSpeedKmh != null && instantDistanceSpeedKmh > previousEstimatedSpeedKmh);

    if (!corroboratedByDistance) {
      estimatedSpeedKmh = Math.min(estimatedSpeedKmh, maxRise);
    }
  }

  estimatedSpeedKmh = clamp(estimatedSpeedKmh, 0, MAX_REASONABLE_SPEED_KMH);
  if (estimatedSpeedKmh < MIN_MOVING_SPEED_KMH || stationaryByWindow) {
    estimatedSpeedKmh = 0;
  }

  let displaySpeedKmh = estimatedSpeedKmh;
  if (!isReliable) {
    displaySpeedKmh = previousDisplaySpeedKmh * 0.6;
  } else if (estimatedSpeedKmh === 0 || stationaryByWindow) {
    displaySpeedKmh = 0;
  } else if (previousDisplaySpeedKmh > 0) {
    const alpha = estimatedSpeedKmh >= previousDisplaySpeedKmh ? 0.35 : 0.5;
    displaySpeedKmh =
      previousDisplaySpeedKmh * (1 - alpha) + estimatedSpeedKmh * alpha;
  }

  if (displaySpeedKmh < MIN_MOVING_SPEED_KMH) {
    displaySpeedKmh = 0;
  }

  const historySample: SpeedHistorySample = {
    latitude: reading.latitude,
    longitude: reading.longitude,
    time: reading.time,
    accuracy,
    estimatedSpeedKmh,
    sensorSpeedKmh,
    reliable: isReliable,
  };

  return {
    estimatedSpeedKmh: round1(estimatedSpeedKmh),
    displaySpeedKmh: round1(displaySpeedKmh),
    sensorSpeedKmh: sensorSpeedKmh != null ? round1(sensorSpeedKmh) : null,
    instantDistanceSpeedKmh:
      instantDistanceSpeedKmh != null ? round1(instantDistanceSpeedKmh) : null,
    windowSpeedKmh: windowSpeedKmh != null ? round1(windowSpeedKmh) : null,
    distanceFromPreviousMeters: Math.round(distanceFromPreviousMeters * 10) / 10,
    isReliable,
    isMoving: estimatedSpeedKmh >= 8,
    nextHistory: trimHistory([...stableHistory, historySample], reading.time),
  };
}

export function shouldUploadTripLocation(
  point: TripLocationPoint,
  lastUploadedPoint: TripLocationPoint | null
): boolean {
  if (!point.reliable) return false;
  if (!lastUploadedPoint) return true;

  const elapsedMs = point.time - lastUploadedPoint.time;
  if (elapsedMs >= 5_000) return true;

  const distanceMeters =
    distanceKm(
      point.latitude,
      point.longitude,
      lastUploadedPoint.latitude,
      lastUploadedPoint.longitude
    ) * 1000;

  if (elapsedMs >= 2_000 && point.speed >= 12) return true;
  if (elapsedMs >= 1_500 && distanceMeters >= Math.max(point.accuracy * 0.6, 8)) return true;

  return false;
}

export function summarizeTripPoints(
  points: TripLocationPoint[],
  tripStartedAtMs: number | null,
  tripEndedAtMs: number | null
): {
  totalDistanceKm: number;
  averageSpeedKmh: number;
  movingAverageSpeedKmh: number;
} {
  const sorted = [...points]
    .filter(
      (point) =>
        point.reliable &&
        point.accuracy <= USABLE_ACCURACY_METERS &&
        Number.isFinite(point.latitude) &&
        Number.isFinite(point.longitude)
    )
    .sort((a, b) => a.time - b.time);

  let totalDistanceKm = 0;
  let movingTimeMs = 0;

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const deltaTimeMs = current.time - previous.time;
    if (deltaTimeMs <= 0 || deltaTimeMs > 30_000) continue;

    const distanceMeters =
      distanceKm(previous.latitude, previous.longitude, current.latitude, current.longitude) * 1000;
    const segmentNoiseFloor = noiseFloorMeters(previous.accuracy, current.accuracy);
    if (distanceMeters <= segmentNoiseFloor) continue;

    const segmentSpeedKmh = metersToKmh(distanceMeters, deltaTimeMs);
    if (segmentSpeedKmh > MAX_REASONABLE_SPEED_KMH) continue;

    totalDistanceKm += distanceMeters / 1000;
    movingTimeMs += deltaTimeMs;
  }

  const durationMs =
    tripStartedAtMs != null && tripEndedAtMs != null && tripEndedAtMs > tripStartedAtMs
      ? tripEndedAtMs - tripStartedAtMs
      : movingTimeMs;

  const averageSpeedKmh =
    durationMs > 0 ? totalDistanceKm / (durationMs / 3_600_000) : 0;
  const movingAverageSpeedKmh =
    movingTimeMs > 0 ? totalDistanceKm / (movingTimeMs / 3_600_000) : 0;

  return {
    totalDistanceKm: Math.round(totalDistanceKm * 100) / 100,
    averageSpeedKmh: round1(averageSpeedKmh),
    movingAverageSpeedKmh: round1(movingAverageSpeedKmh),
  };
}
