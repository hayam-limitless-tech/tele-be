import {
  summarizeTripPoints,
  updateSpeedEstimate,
  type SpeedHistorySample,
} from '../speedEstimator';

describe('speedEstimator', () => {
  test('rejects noisy sensor speed when displacement stays inside GPS jitter', () => {
    let history: SpeedHistorySample[] = [];
    let displaySpeedKmh = 0;

    const baseLat = 33.8938;
    const baseLng = 35.5018;

    for (let index = 0; index < 4; index += 1) {
      const estimate = updateSpeedEstimate(
        history,
        {
          latitude: baseLat + index * 0.000002,
          longitude: baseLng + index * 0.000002,
          time: index * 2000,
          accuracy: 8,
          coordsSpeedMps: 0,
        },
        displaySpeedKmh
      );
      history = estimate.nextHistory;
      displaySpeedKmh = estimate.displaySpeedKmh;
    }

    const noisyEstimate = updateSpeedEstimate(
      history,
      {
        latitude: baseLat + 0.000003,
        longitude: baseLng + 0.000003,
        time: 8000,
        accuracy: 8,
        coordsSpeedMps: 5.6,
      },
      displaySpeedKmh
    );

    expect(noisyEstimate.isReliable).toBe(true);
    expect(noisyEstimate.estimatedSpeedKmh).toBe(0);
    expect(noisyEstimate.displaySpeedKmh).toBe(0);
  });

  test('accepts movement when GPS displacement and device speed agree', () => {
    let history: SpeedHistorySample[] = [];
    let displaySpeedKmh = 0;

    const movingPoints = [
      { latitude: 33.8938, longitude: 35.5018, time: 0 },
      { latitude: 33.89392, longitude: 35.5018, time: 2000 },
      { latitude: 33.89404, longitude: 35.5018, time: 4000 },
    ];

    for (const point of movingPoints) {
      const estimate = updateSpeedEstimate(
        history,
        {
          ...point,
          accuracy: 6,
          coordsSpeedMps: 7.5,
        },
        displaySpeedKmh
      );
      history = estimate.nextHistory;
      displaySpeedKmh = estimate.displaySpeedKmh;
    }

    const confirmedMovement = updateSpeedEstimate(
      history,
      {
        latitude: 33.89416,
        longitude: 35.5018,
        time: 6000,
        accuracy: 6,
        coordsSpeedMps: 7.5,
      },
      displaySpeedKmh
    );

    expect(confirmedMovement.isReliable).toBe(true);
    expect(confirmedMovement.estimatedSpeedKmh).toBeGreaterThan(20);
    expect(confirmedMovement.windowSpeedKmh).not.toBeNull();
  });

  test('summarizes trip distance while filtering tiny jitter segments', () => {
    const summary = summarizeTripPoints(
      [
        {
          latitude: 33.8938,
          longitude: 35.5018,
          time: 0,
          speed: 0,
          accuracy: 7,
          reliable: true,
        },
        {
          latitude: 33.893801,
          longitude: 35.501801,
          time: 1000,
          speed: 0,
          accuracy: 7,
          reliable: true,
        },
        {
          latitude: 33.8941,
          longitude: 35.5018,
          time: 5000,
          speed: 24,
          accuracy: 7,
          reliable: true,
        },
      ],
      0,
      5000
    );

    expect(summary.totalDistanceKm).toBeGreaterThan(0.02);
    expect(summary.averageSpeedKmh).toBeGreaterThan(15);
  });

  test('ignores unreliable trip points when summarizing a trip', () => {
    const summary = summarizeTripPoints(
      [
        {
          latitude: 33.8938,
          longitude: 35.5018,
          time: 0,
          speed: 0,
          accuracy: 6,
          reliable: true,
        },
        {
          latitude: 33.9005,
          longitude: 35.5018,
          time: 2000,
          speed: 80,
          accuracy: 80,
          reliable: false,
        },
        {
          latitude: 33.89405,
          longitude: 35.5018,
          time: 5000,
          speed: 20,
          accuracy: 6,
          reliable: true,
        },
      ],
      0,
      5000
    );

    expect(summary.totalDistanceKm).toBeLessThan(0.05);
    expect(summary.averageSpeedKmh).toBeLessThan(30);
  });
});
