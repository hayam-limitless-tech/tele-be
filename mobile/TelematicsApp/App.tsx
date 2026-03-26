import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  PermissionsAndroid,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import CommunityGeolocation from '@react-native-community/geolocation';
import Geolocation from 'react-native-geolocation-service';
import { accelerometer, SensorTypes, setUpdateIntervalForType } from 'react-native-sensors';
import { addLocationPoint, createTrip, endTrip } from './api';
import { startForegroundService, stopForegroundService } from './ForegroundService';
// @ts-ignore - JavaScript module without type declarations
import { getSpeedLimitCached } from './speedLimitService';
import {
  shouldUploadTripLocation,
  summarizeTripPoints,
  updateSpeedEstimate,
} from './speedEstimator';
import type { SpeedHistorySample, TripLocationPoint } from './speedEstimator';

type TripStatus = 'idle' | 'driving';
const CRASH_SIGNAL_WINDOW_MS = 2500;

function isAndroidEmulator(): boolean {
  if (Platform.OS !== 'android') return false;
  const constants = (Platform as typeof Platform & { constants?: Record<string, unknown> }).constants;
  const fingerprint = typeof constants?.Fingerprint === 'string' ? constants.Fingerprint : '';
  const model = typeof constants?.Model === 'string' ? constants.Model : '';
  const brand = typeof constants?.Brand === 'string' ? constants.Brand : '';

  return (
    fingerprint.includes('generic') ||
    fingerprint.includes('emulator') ||
    model.toLowerCase().includes('sdk') ||
    brand.toLowerCase().includes('generic')
  );
}

function App() {
  const runningOnAndroidEmulator = isAndroidEmulator();
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [status, setStatus] = useState<TripStatus>('idle');
  const [speedKmh, setSpeedKmh] = useState(0);
  const [safetyScore, setSafetyScore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [harshBrakeCount, setHarshBrakeCount] = useState(0);
  const [harshAccelerationCount, setHarshAccelerationCount] = useState(0);
  const [currentSpeedLimit, setCurrentSpeedLimit] = useState<number | null>(null);
  const [speedingViolations, setSpeedingViolations] = useState(0);
  const [isStartingTrip, setIsStartingTrip] = useState(false);

  const tripIdRef = useRef<number | null>(null);
  const lastLocationRef = useRef<{ lat: number; lng: number; time: number } | null>(null);
  const latestTripPointRef = useRef<TripLocationPoint | null>(null);
  const tripStartTimeRef = useRef<number | null>(null);
  const batteryPromptShownRef = useRef(false);
  const tripLocationBuffer = useRef<TripLocationPoint[]>([]);
  const speedHistoryRef = useRef<SpeedHistorySample[]>([]);
  const lastReliableTripPointRef = useRef<TripLocationPoint | null>(null);
  const lastUploadedTripPointRef = useRef<TripLocationPoint | null>(null);
  const lastHarshBrakeTimeRef = useRef<number>(0);
  const lastHarshAccelTimeRef = useRef<number>(0);
  const harshBrakeCountRef = useRef<number>(0);
  const harshAccelCountRef = useRef<number>(0);
  const harshEventsRef = useRef<
    Array<{ type: string; timestamp: string; latitude: number; longitude: number; speed: number }>
  >([]);
  const accelerometerMagnitudeRef = useRef<number>(9.8);
  const crashDetectedRef = useRef<boolean>(false);
  const crashLatRef = useRef<number | null>(null);
  const crashLngRef = useRef<number | null>(null);
  const speedBasedCrashTimeRef = useRef<number | null>(null);
  const sensorBasedCrashTimeRef = useRef<number | null>(null);
  const speedingDurationRef = useRef<number>(0);
  const speedingViolationsRef = useRef<number>(0);
  const maxSpeedOverLimitRef = useRef<number>(0);
  const lastSpeedCheckTimeRef = useRef<number>(0);
  const wasSpeedingRef = useRef<boolean>(false);
  const speedingStartTimeRef = useRef<number | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const smoothedSpeedRef = useRef<number>(0);
  const recentSpeedSamplesRef = useRef<Array<{ speedKmh: number; time: number }>>([]);
  const autoStartInProgressRef = useRef<boolean>(false);
  const locationClient: any = runningOnAndroidEmulator ? CommunityGeolocation : Geolocation;

  const geolocationOptions =
    Platform.OS === 'android'
      ? {
          enableHighAccuracy: true,
          distanceFilter: 1,
          interval: 1000,
          fastestInterval: 1000,
          ...(runningOnAndroidEmulator
            ? {}
            : {
                showLocationDialog: false,
                forceRequestLocation: false,
                forceLocationManager: false,
              }),
        }
      : {
          enableHighAccuracy: true,
          distanceFilter: 1,
          interval: 1000,
          fastestInterval: 1000,
          showsBackgroundLocationIndicator: true,
        };

  function requestCurrentPosition(timeout = 10_000, maximumAge = 15_000): Promise<any> {
    return new Promise((resolve, reject) => {
      locationClient.getCurrentPosition(resolve, reject, {
        ...geolocationOptions,
        maximumAge,
        timeout,
      });
    });
  }

  function handleLocationSample(position: any) {
    const coords = position?.coords;
    const lat = coords?.latitude != null ? Number(coords.latitude) : NaN;
    const lng = coords?.longitude != null ? Number(coords.longitude) : NaN;
    if (Number.isNaN(lat) || Number.isNaN(lng)) return;

    const latitude = lat;
    const longitude = lng;
    const timestamp = position.timestamp;
    const time =
      typeof timestamp === 'number'
        ? timestamp < 1e12
          ? timestamp * 1000
          : timestamp
        : Date.now();
    const accuracy =
      typeof coords?.accuracy === 'number' && Number.isFinite(coords.accuracy)
        ? coords.accuracy
        : 999;
    const coordsSpeedMs =
      typeof (coords as { speed?: number | null })?.speed === 'number'
        ? Number((coords as { speed?: number | null }).speed)
        : null;
    const speedAccuracyMs =
      typeof (coords as { speedAccuracy?: number | null })?.speedAccuracy === 'number'
        ? Number((coords as { speedAccuracy?: number | null }).speedAccuracy)
        : null;

    const estimate = updateSpeedEstimate(
      speedHistoryRef.current,
      {
        latitude,
        longitude,
        time,
        accuracy,
        coordsSpeedMps: coordsSpeedMs,
        speedAccuracyMps: speedAccuracyMs,
      },
      smoothedSpeedRef.current
    );

    speedHistoryRef.current = estimate.nextHistory;
    smoothedSpeedRef.current = estimate.displaySpeedKmh;
    setSpeedKmh(estimate.displaySpeedKmh);
    setError(null);

    const currentPoint: TripLocationPoint = {
      latitude,
      longitude,
      time,
      speed: estimate.estimatedSpeedKmh,
      accuracy,
      reliable: estimate.isReliable,
    };

    latestTripPointRef.current = currentPoint;
    lastLocationRef.current = { lat: latitude, lng: longitude, time };

    const speedForDecisions = estimate.isReliable ? estimate.estimatedSpeedKmh : 0;

    if (tripIdRef.current == null && !autoStartInProgressRef.current) {
      recentSpeedSamplesRef.current.push({ speedKmh: speedForDecisions, time });
      const windowMs = 30_000;
      recentSpeedSamplesRef.current = recentSpeedSamplesRef.current.filter(
        (sample) => time - sample.time <= windowMs
      );

      const lastTenSeconds = recentSpeedSamplesRef.current.filter(
        (sample) => time - sample.time <= 12_000
      );
      if (lastTenSeconds.length >= 4) {
        const averageSpeed =
          lastTenSeconds.reduce((sum, sample) => sum + sample.speedKmh, 0) /
          lastTenSeconds.length;
        const fastSamples = lastTenSeconds.filter((sample) => sample.speedKmh >= 8).length;
        const displacementConfirmed =
          estimate.windowSpeedKmh != null ? estimate.windowSpeedKmh >= 8 : estimate.isMoving;

        if (
          estimate.isReliable &&
          fastSamples >= 4 &&
          averageSpeed >= 18 &&
          displacementConfirmed
        ) {
          autoStartInProgressRef.current = true;
          handleStartTrip();
        }
      }
    }

    const activeTripId = tripIdRef.current;
    if (activeTripId != null) {
      tripLocationBuffer.current.push(currentPoint);

      if (
        currentPoint.reliable &&
        shouldUploadTripLocation(currentPoint, lastUploadedTripPointRef.current)
      ) {
        lastUploadedTripPointRef.current = currentPoint;
        void addLocationPoint(
          activeTripId,
          latitude,
          longitude,
          currentPoint.speed,
          currentPoint.accuracy,
          new Date(time).toISOString()
        ).catch((uploadError: any) => {
          console.warn('Location upload failed:', uploadError?.message || uploadError);
        });
      }

      const previousReliablePoint = lastReliableTripPointRef.current;
      if (currentPoint.reliable && previousReliablePoint) {
        const timeDeltaSec = (time - previousReliablePoint.time) / 1000;

        if (timeDeltaSec >= 0.5 && timeDeltaSec <= 5) {
          const accelMagnitude = accelerometerMagnitudeRef.current;
          const sensorFlagged = accelMagnitude > 13;
          const speedDrop = previousReliablePoint.speed - currentPoint.speed;
          const speedRise = currentPoint.speed - previousReliablePoint.speed;
          const speedDropPercent =
            previousReliablePoint.speed > 0
              ? (speedDrop / previousReliablePoint.speed) * 100
              : 0;
          const speedRisePercent =
            previousReliablePoint.speed > 0
              ? (speedRise / previousReliablePoint.speed) * 100
              : 0;
          const speedFlaggedBrake = speedDropPercent >= 30;
          const speedFlaggedAccel = speedRisePercent >= 30;
          const gpsGood = currentPoint.accuracy <= 25;

          let countBrake = false;
          let countAccel = false;

          if (gpsGood) {
            if (speedFlaggedBrake && sensorFlagged) countBrake = true;
            if (speedFlaggedAccel && sensorFlagged) countAccel = true;
          } else if (sensorFlagged) {
            if (speedFlaggedBrake) {
              countBrake = true;
            } else if (speedFlaggedAccel) {
              countAccel = true;
            }
          }

          const now = time;
          if (countBrake && now - lastHarshBrakeTimeRef.current >= 3000) {
            harshBrakeCountRef.current += 1;
            setHarshBrakeCount(harshBrakeCountRef.current);
            lastHarshBrakeTimeRef.current = now;
            harshEventsRef.current.push({
              type: 'braking',
              timestamp: new Date(now).toISOString(),
              latitude,
              longitude,
              speed: currentPoint.speed,
            });
          }

          if (countAccel && now - lastHarshAccelTimeRef.current >= 3000) {
            harshAccelCountRef.current += 1;
            setHarshAccelerationCount(harshAccelCountRef.current);
            lastHarshAccelTimeRef.current = now;
            harshEventsRef.current.push({
              type: 'acceleration',
              timestamp: new Date(now).toISOString(),
              latitude,
              longitude,
              speed: currentPoint.speed,
            });
          }
        }

        if (previousReliablePoint.speed >= 20 && currentPoint.speed < 5 && timeDeltaSec < 2) {
          speedBasedCrashTimeRef.current = time;
        }
      }

      if (currentPoint.reliable) {
        lastReliableTripPointRef.current = currentPoint;
      }

      if (
        speedBasedCrashTimeRef.current != null &&
        time - speedBasedCrashTimeRef.current > CRASH_SIGNAL_WINDOW_MS
      ) {
        speedBasedCrashTimeRef.current = null;
      }
      if (
        sensorBasedCrashTimeRef.current != null &&
        time - sensorBasedCrashTimeRef.current > CRASH_SIGNAL_WINDOW_MS
      ) {
        sensorBasedCrashTimeRef.current = null;
      }

      if (
        speedBasedCrashTimeRef.current != null &&
        sensorBasedCrashTimeRef.current != null &&
        Math.abs(speedBasedCrashTimeRef.current - sensorBasedCrashTimeRef.current) <=
          CRASH_SIGNAL_WINDOW_MS &&
        !crashDetectedRef.current
      ) {
        crashDetectedRef.current = true;
        crashLatRef.current = latitude;
        crashLngRef.current = longitude;
        speedBasedCrashTimeRef.current = null;
        sensorBasedCrashTimeRef.current = null;
      }

      const timeSinceLastCheck = time - lastSpeedCheckTimeRef.current;
      if (currentPoint.reliable && timeSinceLastCheck >= 10_000) {
        lastSpeedCheckTimeRef.current = time;

        getSpeedLimitCached(latitude, longitude)
          .then((limitData: any) => {
            setCurrentSpeedLimit(limitData.speedLimit);

            const tolerance = 5;
            const isSpeeding = currentPoint.speed > limitData.speedLimit + tolerance;

            if (isSpeeding && !wasSpeedingRef.current) {
              wasSpeedingRef.current = true;
              speedingStartTimeRef.current = time;
              speedingViolationsRef.current += 1;
              setSpeedingViolations(speedingViolationsRef.current);
            } else if (!isSpeeding && wasSpeedingRef.current) {
              wasSpeedingRef.current = false;
              if (speedingStartTimeRef.current) {
                speedingDurationRef.current += (time - speedingStartTimeRef.current) / 1000;
                speedingStartTimeRef.current = null;
              }
            }

            if (isSpeeding) {
              const overLimit = currentPoint.speed - limitData.speedLimit;
              if (overLimit > maxSpeedOverLimitRef.current) {
                maxSpeedOverLimitRef.current = overLimit;
              }
            }
          })
          .catch((speedLimitError: any) => {
            console.warn('Speed limit check failed:', speedLimitError);
          });
      }
    }
  }

  useEffect(() => {
    if (Platform.OS !== 'android' || !runningOnAndroidEmulator) return;

    CommunityGeolocation.setRNConfiguration({
      skipPermissionRequests: true,
      locationProvider: 'android',
    });
  }, [runningOnAndroidEmulator]);

  useEffect(() => {
    let cancelled = false;

    async function askPermission() {
      if (Platform.OS !== 'android') {
        setPermissionGranted(true);
        return;
      }

      try {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          {
            title: 'Location permission',
            message: 'This app needs location to track trips.',
            buttonNeutral: 'Ask Me Later',
            buttonNegative: 'Cancel',
            buttonPositive: 'OK',
          }
        );

        if (!cancelled && granted !== PermissionsAndroid.RESULTS.GRANTED) {
          return;
        }

        await PermissionsAndroid.request(
          (PermissionsAndroid as any).PERMISSIONS?.ACCESS_BACKGROUND_LOCATION ??
            'android.permission.ACCESS_BACKGROUND_LOCATION',
          {
            title: 'Background location',
            message: 'Allow all the time so we can record your trip when the app is in the background.',
            buttonNeutral: 'Ask Me Later',
            buttonNegative: 'Cancel',
            buttonPositive: 'OK',
          }
        );

        const apiLevel = Platform.OS === 'android' ? (Platform as any).Version : 0;
        if (apiLevel >= 33) {
          await PermissionsAndroid.request(
            (PermissionsAndroid as any).PERMISSIONS?.POST_NOTIFICATIONS ??
              'android.permission.POST_NOTIFICATIONS',
            {
              title: 'Notification permission',
              message: 'Show a notification while a trip is being recorded.',
              buttonNeutral: 'Ask Me Later',
              buttonNegative: 'Cancel',
              buttonPositive: 'OK',
            }
          );
        }

        if (!cancelled) {
          setPermissionGranted(true);
        }
      } catch {
        if (!cancelled) setPermissionGranted(true);
      }
    }

    askPermission();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!permissionGranted) return;

    setError(null);

    let watchId: number | null = null;
    let emulatorPollInterval: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const startWatching = () => {
      if (cancelled) return;

      try {
        watchId = locationClient.watchPosition(
          handleLocationSample,
          (watchError: any) => {
            setError(`Location error: ${watchError.message}`);
            console.error('Geolocation error:', watchError);
          },
          geolocationOptions
        );

        watchIdRef.current = watchId;

        if (runningOnAndroidEmulator) {
          const pollEmulatorLocation = () => {
            requestCurrentPosition(5000, 5000)
              .then(handleLocationSample)
              .catch((locationError: any) => {
                if (!cancelled && !lastLocationRef.current) {
                  setError(`Location error: ${locationError?.message || 'Unable to read location'}`);
                }
              });
          };

          pollEmulatorLocation();
          emulatorPollInterval = setInterval(pollEmulatorLocation, 1500);
        }
      } catch (watchStartError) {
        console.error('Geolocation.watchPosition failed', watchStartError);
        setError(
          `Failed to start location: ${
            watchStartError instanceof Error ? watchStartError.message : String(watchStartError)
          }`
        );
      }
    };

    const timeout = setTimeout(startWatching, 100);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      if (emulatorPollInterval) {
        clearInterval(emulatorPollInterval);
      }
      if (watchIdRef.current !== null) {
        try {
          locationClient.clearWatch(watchIdRef.current);
        } catch (_clearError) {}
        watchIdRef.current = null;
      }
    };
  }, [permissionGranted, runningOnAndroidEmulator]);

  useEffect(() => {
    let subscription: { unsubscribe: () => void } | null = null;

    try {
      setUpdateIntervalForType(SensorTypes.accelerometer, 200);
    } catch (updateIntervalError) {
      console.warn('Accelerometer setUpdateIntervalForType failed', updateIntervalError);
    }

    try {
      subscription = accelerometer.subscribe(({ x, y, z }) => {
        const magnitude = Math.sqrt(x * x + y * y + z * z);
        accelerometerMagnitudeRef.current = magnitude;

        if (magnitude > 39 && tripIdRef.current != null) {
          sensorBasedCrashTimeRef.current = Date.now();
        }
      });
    } catch (subscriptionError) {
      console.warn('Accelerometer subscribe failed', subscriptionError);
    }

    return () => {
      try {
        if (subscription) subscription.unsubscribe();
      } catch (_unsubscribeError) {}
    };
  }, []);

  function showBatteryPrompt() {
    if (batteryPromptShownRef.current) return;
    batteryPromptShownRef.current = true;
    Alert.alert(
      'Important: Battery Settings Required',
      'For accurate trip tracking in the background:\n\n' +
        '1. Tap "Open Settings" below\n' +
        '2. Find "Telematics Safety" in the app list\n' +
        '3. Tap "Battery"\n' +
        '4. Select "Unrestricted" or "Don\'t optimize"\n' +
        '5. Go back to the app\n\n' +
        'Without this, trips may not track correctly when your screen is off.',
      [{ text: 'Open Settings', onPress: () => Linking.openSettings() }],
      { cancelable: false }
    );
  }

  async function handleStartTrip() {
    if (isStartingTrip) return;
    setError(null);

    let position = lastLocationRef.current;
    if (!position) {
      autoStartInProgressRef.current = true;
      try {
        const freshPosition = await requestCurrentPosition(8000, 30_000);
        handleLocationSample(freshPosition);
        position = lastLocationRef.current;
      } catch (locationError: any) {
        setError(locationError?.message ? `Location error: ${locationError.message}` : 'Wait for location');
        autoStartInProgressRef.current = false;
        return;
      }
    }

    if (!position) {
      setError('Wait for location');
      autoStartInProgressRef.current = false;
      return;
    }

    setIsStartingTrip(true);
    try {
      const trip = await createTrip(position.lat, position.lng);
      tripIdRef.current = trip.id;
      tripStartTimeRef.current = Number.isFinite(Date.parse(trip?.start_time))
        ? Date.parse(trip.start_time)
        : Date.now();
      harshBrakeCountRef.current = 0;
      harshAccelCountRef.current = 0;
      harshEventsRef.current = [];
      lastHarshBrakeTimeRef.current = 0;
      lastHarshAccelTimeRef.current = 0;
      crashDetectedRef.current = false;
      crashLatRef.current = null;
      crashLngRef.current = null;
      speedBasedCrashTimeRef.current = null;
      sensorBasedCrashTimeRef.current = null;
      speedingDurationRef.current = 0;
      speedingViolationsRef.current = 0;
      maxSpeedOverLimitRef.current = 0;
      lastSpeedCheckTimeRef.current = 0;
      wasSpeedingRef.current = false;
      speedingStartTimeRef.current = null;
      recentSpeedSamplesRef.current = [];
      setStatus('driving');
      setSafetyScore(null);
      setHarshBrakeCount(0);
      setHarshAccelerationCount(0);
      setCurrentSpeedLimit(null);
      setSpeedingViolations(0);

      const latestPoint = latestTripPointRef.current;
      tripLocationBuffer.current = latestPoint ? [latestPoint] : [];
      lastReliableTripPointRef.current = latestPoint?.reliable ? latestPoint : null;
      lastUploadedTripPointRef.current = null;

      if (latestPoint?.reliable) {
        lastUploadedTripPointRef.current = latestPoint;
        void addLocationPoint(
          trip.id,
          latestPoint.latitude,
          latestPoint.longitude,
          latestPoint.speed,
          latestPoint.accuracy,
          new Date(latestPoint.time).toISOString()
        ).catch((uploadError: any) => {
          console.warn('Initial location upload failed:', uploadError?.message || uploadError);
        });
      }

      if (Platform.OS === 'android') {
        try {
          await startForegroundService();
        } catch (_foregroundServiceError) {}
        if (!runningOnAndroidEmulator) {
          showBatteryPrompt();
        }
      }
    } catch (startError: any) {
      setError(startError?.message || 'Failed to start trip');
    } finally {
      setIsStartingTrip(false);
      autoStartInProgressRef.current = false;
    }
  }

  async function handleEndTrip() {
    if (tripIdRef.current == null) return;
    setError(null);

    const position = lastLocationRef.current;
    if (!position) {
      setError('Wait for location');
      return;
    }

    try {
      if (wasSpeedingRef.current && speedingStartTimeRef.current) {
        speedingDurationRef.current += (Date.now() - speedingStartTimeRef.current) / 1000;
        wasSpeedingRef.current = false;
      }

      const endedAtMs = Date.now();
      const summary = summarizeTripPoints(
        tripLocationBuffer.current,
        tripStartTimeRef.current,
        endedAtMs
      );
      const averageSpeedKmh =
        summary.averageSpeedKmh > 0 ? summary.averageSpeedKmh : Math.round(speedKmh * 10) / 10;

      const ended = await endTrip(
        tripIdRef.current,
        position.lat,
        position.lng,
        new Date(endedAtMs).toISOString(),
        averageSpeedKmh,
        summary.totalDistanceKm,
        harshBrakeCountRef.current,
        harshAccelCountRef.current,
        crashDetectedRef.current,
        crashLatRef.current,
        crashLngRef.current,
        harshEventsRef.current,
        Math.round(speedingDurationRef.current),
        speedingViolationsRef.current,
        Math.round(maxSpeedOverLimitRef.current * 10) / 10
      );

      setSafetyScore(ended.safety_score ?? 0);
      setStatus('idle');
      tripIdRef.current = null;
      tripStartTimeRef.current = null;
      tripLocationBuffer.current = [];
      latestTripPointRef.current = null;
      lastReliableTripPointRef.current = null;
      lastUploadedTripPointRef.current = null;
      speedBasedCrashTimeRef.current = null;
      sensorBasedCrashTimeRef.current = null;
      harshEventsRef.current = [];
      recentSpeedSamplesRef.current = [];
      autoStartInProgressRef.current = false;

      if (Platform.OS === 'android') {
        try {
          await stopForegroundService();
        } catch (_stopForegroundServiceError) {}
      }
    } catch (endError: any) {
      setError(endError?.message || 'Failed to end trip');
    }
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={styles.container}>
        <Text style={styles.title}>Telematics Safety</Text>
        <View style={styles.row}>
          <Text style={styles.label}>Status:</Text>
          <Text style={styles.value}>{status === 'idle' ? 'Idle' : 'Driving'}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Speed:</Text>
          <Text style={styles.value}>{speedKmh.toFixed(1)} km/h</Text>
        </View>
        {status === 'driving' && currentSpeedLimit != null && (
          <View style={styles.row}>
            <Text style={styles.label}>Speed limit:</Text>
            <Text style={styles.value}>{currentSpeedLimit} km/h</Text>
          </View>
        )}
        {status === 'driving' && (
          <>
            <View style={styles.row}>
              <Text style={styles.label}>Harsh brakes this trip:</Text>
              <Text style={[styles.value, styles.harshBrake]}>{harshBrakeCount}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>Harsh accelerations:</Text>
              <Text style={[styles.value, styles.harshBrake]}>{harshAccelerationCount}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>Speeding violations:</Text>
              <Text style={[styles.value, styles.harshBrake]}>{speedingViolations}</Text>
            </View>
          </>
        )}
        {safetyScore != null && (
          <View style={styles.row}>
            <Text style={styles.label}>Safety score:</Text>
            <Text style={[styles.value, styles.score]}>{safetyScore.toFixed(0)}</Text>
          </View>
        )}
        {error != null && <Text style={styles.error}>{error}</Text>}
        <View style={styles.buttons}>
          {status === 'idle' ? (
            <TouchableOpacity
              style={[styles.button, isStartingTrip && styles.buttonDisabled]}
              onPress={handleStartTrip}
              disabled={isStartingTrip}
            >
              <Text style={styles.buttonText}>{isStartingTrip ? 'Starting…' : 'Start trip'}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={[styles.button, styles.buttonEnd]} onPress={handleEndTrip}>
              <Text style={styles.buttonText}>End trip</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: '#f5f5f5',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 24,
  },
  row: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  label: {
    fontSize: 18,
    color: '#333',
    marginRight: 8,
  },
  value: {
    fontSize: 18,
    fontWeight: '600',
  },
  score: {
    fontSize: 22,
    color: '#2e7d32',
  },
  harshBrake: {
    color: '#c62828',
  },
  error: {
    color: '#c62828',
    marginTop: 8,
  },
  buttons: {
    marginTop: 24,
  },
  button: {
    backgroundColor: '#1976d2',
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonEnd: {
    backgroundColor: '#d32f2f',
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
});

export default App;
