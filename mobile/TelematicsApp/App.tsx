import React, { useEffect, useState, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  StatusBar,
  Alert,
  Platform,
  PermissionsAndroid,
  Linking,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import Geolocation from 'react-native-geolocation-service';
import { accelerometer, setUpdateIntervalForType, SensorTypes } from 'react-native-sensors';
import {
  createTrip,
  addLocationPoint,
  endTrip,
} from './api';
// @ts-ignore - JavaScript module without type declarations
import { getSpeedLimitCached } from './speedLimitService';
import { startForegroundService, stopForegroundService } from './ForegroundService';

type TripStatus = 'idle' | 'driving';

function App() {
  // --- STATE (drives UI re-renders) ---
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

  // --- REFS (persist across renders, used in callbacks without causing re-renders) ---
  const tripIdRef = useRef<number | null>(null); // Backend trip ID when driving
  const lastLocationRef = useRef<{ lat: number; lng: number; time: number } | null>(null); // Last GPS point for speed calc + start/end
  const speedSumRef = useRef(0); // Running sum of speeds for average (end trip)
  const speedCountRef = useRef(0); // Count of speed samples
  const batteryPromptShownRef = useRef(false); // Show battery prompt only once per session
  const tripLocationBuffer = useRef<Array<{ lat: number; lng: number; time: number; speed: number }>>([]);
  const lastHarshBrakeTimeRef = useRef<number>(0); // Last harsh brake timestamp (for cooldown)
  const lastHarshAccelTimeRef = useRef<number>(0); // Last harsh accel timestamp (for cooldown)
  const harshBrakeCountRef = useRef<number>(0); // Harsh brake count for callback access
  const harshAccelCountRef = useRef<number>(0); // Harsh accel count for callback access
  const harshEventsRef = useRef<Array<{type: string; timestamp: string; latitude: number; longitude: number; speed: number}>>([]); // Array of harsh events with locations
  const accelerometerMagnitudeRef = useRef<number>(9.8); // Latest |a| for harsh event detection
  const crashDetectedRef = useRef<boolean>(false); // Crash detected flag
  const crashLatRef = useRef<number | null>(null); // Crash latitude
  const crashLngRef = useRef<number | null>(null); // Crash longitude
  const speedBasedCrashRef = useRef<boolean>(false); // Speed indicates crash
  const sensorBasedCrashRef = useRef<boolean>(false); // Sensor indicates crash
  const speedingDurationRef = useRef<number>(0); // Total seconds spent speeding
  const speedingViolationsRef = useRef<number>(0); // Number of speeding incidents
  const maxSpeedOverLimitRef = useRef<number>(0); // Max km/h over limit
  const lastSpeedCheckTimeRef = useRef<number>(0); // Last time we checked speed limit
  const currentSpeedLimitRef = useRef<number | null>(null); // Current road speed limit
  const wasSpeedingRef = useRef<boolean>(false); // Was speeding in last check
  const speedingStartTimeRef = useRef<number | null>(null); // When current speeding started
  const watchIdRef = useRef<number | null>(null); // Geolocation watch ID for cleanup
  const smoothedSpeedRef = useRef<number>(0); // Exponential moving average for display (reduces GPS jitter)
  const recentSpeedSamplesRef = useRef<Array<{ speedKmh: number; time: number }>>([]); // Last ~30s for auto-start
  const autoStartInProgressRef = useRef<boolean>(false); // Prevent double auto-start while handleStartTrip runs

  // --- EFFECT 1: Permission flow (runs once on mount) ---
  useEffect(() => {
    let cancelled = false; // Prevent state updates after unmount
    async function askPermission() {
      if (Platform.OS !== 'android') {
        setPermissionGranted(true); // iOS handles permissions via Info.plist
        return;
      }
      try {
        // Step 1: Request foreground location (required first)
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
          return; // User denied; app stays without permission
        }

        // Step 2: Request background location (Android 10+; needed for tracking when app is backgrounded)
        const bgGranted = await PermissionsAndroid.request(
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
        // Step 3: Request notification permission (Android 13+); required before showing trip notification
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
          setPermissionGranted(true); // Proceed even if background denied; app still works
        }
      } catch {
        if (!cancelled) setPermissionGranted(true);
      }
    }
    askPermission();
    return () => { cancelled = true; }; // Cleanup: avoid setState on unmounted component
  }, []);

  // --- EFFECT 2: Start Geolocation tracking (runs when permission granted) ---
  useEffect(() => {
    if (!permissionGranted) return;

    setError(null);

    let watchId: number | null = null;
    let cancelled = false;

    const startWatching = () => {
      if (cancelled) return;
      try {
        watchId = Geolocation.watchPosition(
      (position) => {
        // Location update callback - same logic as before (accept coerced numbers for emulator)
        const coords = position?.coords;
        const lat = coords?.latitude != null ? Number(coords.latitude) : NaN;
        const lng = coords?.longitude != null ? Number(coords.longitude) : NaN;
        if (Number.isNaN(lat) || Number.isNaN(lng)) return;
        const latitude = lat;
        const longitude = lng;
        const location = {
          coords: { ...coords, latitude, longitude },
          timestamp: position.timestamp,
        };
        setError(null); // Clear error once we get first location
        const ts = location.timestamp;
        const time = typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : Date.now();

      // Speed: prefer device coords.speed (m/s); else computed from GPS with thresholds to avoid jitter when stationary
      const prev = lastLocationRef.current;
      const timeDeltaMs = prev ? time - prev.time : 0;
      const accuracy = location.coords.accuracy ?? 999;
      const coordsSpeedMs = (location.coords as { speed?: number | null }).speed;
      const coordsSpeedKmh = coordsSpeedMs != null && coordsSpeedMs >= 0 ? coordsSpeedMs * 3.6 : null;

      let speed = 0;
      let prevSpeed = 0;
      if (coordsSpeedKmh != null) {
        speed = coordsSpeedKmh;
      } else if (prev && timeDeltaMs >= 1500) {
        const distKm = distanceKm(prev.lat, prev.lng, latitude, longitude);
        const timeHours = timeDeltaMs / 1000 / 3600;
        const accuracyOk = accuracy <= 35 || accuracy > 500; // Allow when good or when unknown/emulator (no fix)
        if (timeHours > 0 && distKm >= 0.015 && accuracyOk) {
          speed = distKm / timeHours;
        }
      }

      const rawSpeed = speed;
      const alpha = 0.35;
      smoothedSpeedRef.current = smoothedSpeedRef.current * (1 - alpha) + speed * alpha;
      if (speed < 2) smoothedSpeedRef.current = speed;
      const displaySpeed = Math.round(smoothedSpeedRef.current * 10) / 10;
      setSpeedKmh(displaySpeed);
      if (tripIdRef.current != null) {
        speedSumRef.current += rawSpeed;
        speedCountRef.current += 1;
      }

      const buffer = tripLocationBuffer.current;
      if (buffer.length > 0) prevSpeed = buffer[buffer.length - 1].speed;

      // Update lastLocationRef when position changed (or first fix), so Start trip has a location and timeDelta is correct. Always set on first fix so emulator single-point or script gets a location.
      const minDistKm = 0.005; // ~5 m
      const moved = !prev || distanceKm(prev.lat, prev.lng, latitude, longitude) >= minDistKm;
      if (moved || !lastLocationRef.current) {
        lastLocationRef.current = { lat: latitude, lng: longitude, time };
      }

      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/8b754506-153e-4207-8319-1aa43d33ed2a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c1458a'},body:JSON.stringify({sessionId:'c1458a',location:'App.tsx:speed',message:'speed debug',data:{timeDeltaMs,rawSpeedKmh:rawSpeed,displaySpeedKmh:displaySpeed,coordsSpeedKmh,accuracy},timestamp:Date.now(),hypothesisId:'H1'})}).catch(()=>{});
      // #endregion

      // Auto-detect car ride: when idle, sustained speed > 15 km/h for 10+ seconds starts trip
      if (tripIdRef.current == null && !autoStartInProgressRef.current) {
        recentSpeedSamplesRef.current.push({ speedKmh: rawSpeed, time });
        const windowMs = 30000;
        const now = time;
        recentSpeedSamplesRef.current = recentSpeedSamplesRef.current.filter((s) => now - s.time <= windowMs);
        const recent = recentSpeedSamplesRef.current;
        const last10 = recent.filter((s) => now - s.time <= 12000);
        if (last10.length >= 3) {
          const avg = last10.reduce((a, s) => a + s.speedKmh, 0) / last10.length;
          if (avg >= 15) {
            autoStartInProgressRef.current = true;
            handleStartTrip();
          }
        }
      }

      // If we're on an active trip, store this point in memory and detect harsh events
      if (tripIdRef.current != null) {
        tripLocationBuffer.current.push({ lat: latitude, lng: longitude, time, speed: rawSpeed });
        
        // Harsh braking/acceleration detection (speed + accelerometer, Phase 3)
        if (prev && speedCountRef.current >= 2) {
          const timeDeltaSec = (time - prev.time) / 1000;
          
          if (timeDeltaSec >= 0.5 && timeDeltaSec <= 5) {
            // Check GPS quality
            const gpsGood = isGpsGood(location, time - prev.time);
            const accelMagnitude = accelerometerMagnitudeRef.current;
            const sensorFlagged = accelMagnitude > 13; // m/s²
            
            // Speed-based signals (percentage-based: 30% change)
            const speedDrop = prevSpeed - rawSpeed;
            const speedRise = rawSpeed - prevSpeed;
            const speedDropPercent = prevSpeed > 0 ? (speedDrop / prevSpeed) * 100 : 0;
            const speedRisePercent = prevSpeed > 0 ? (speedRise / prevSpeed) * 100 : 0;
            const speedFlaggedBrake = speedDropPercent >= 30; // 30% speed drop
            const speedFlaggedAccel = speedRisePercent >= 30; // 30% speed rise
            
            // Decision logic: both sources must agree; sensor has priority when GPS spotty
            let countBrake = false;
            let countAccel = false;
            
            if (gpsGood) {
              // GPS good: require BOTH speed AND sensor
              if (speedFlaggedBrake && sensorFlagged) countBrake = true;
              if (speedFlaggedAccel && sensorFlagged) countAccel = true;
            } else {
              // GPS spotty: sensor alone can count
              if (sensorFlagged) {
                // Use speed trend to infer direction (if available)
                if (speedFlaggedBrake) {
                  countBrake = true;
                } else if (speedFlaggedAccel) {
                  countAccel = true;
                } else {
                  // No clear speed trend: default to brake (conservative)
                  countBrake = true;
                }
              }
            }
            
            // Apply cooldown and increment
            const now = time;
            if (countBrake && now - lastHarshBrakeTimeRef.current >= 3000) {
              harshBrakeCountRef.current += 1;
              setHarshBrakeCount(harshBrakeCountRef.current);
              lastHarshBrakeTimeRef.current = now;
              // Store event with location and timestamp
              harshEventsRef.current.push({
                type: 'braking',
                timestamp: new Date(now).toISOString(),
                latitude,
                longitude,
                speed: rawSpeed
              });
            }
            if (countAccel && now - lastHarshAccelTimeRef.current >= 3000) {
              harshAccelCountRef.current += 1;
              setHarshAccelerationCount(harshAccelCountRef.current);
              lastHarshAccelTimeRef.current = now;
              // Store event with location and timestamp
              harshEventsRef.current.push({
                type: 'acceleration',
                timestamp: new Date(now).toISOString(),
                latitude,
                longitude,
                speed: rawSpeed
              });
            }
          }
          
          // Crash detection (speed-based)
          if (prev && prevSpeed >= 20 && rawSpeed < 5 && timeDeltaSec < 2) {
            speedBasedCrashRef.current = true;
          }
        }
        
        // Check if both speed and sensor detected crash
        if (speedBasedCrashRef.current && sensorBasedCrashRef.current && !crashDetectedRef.current) {
          crashDetectedRef.current = true;
          crashLatRef.current = latitude;
          crashLngRef.current = longitude;
          // Reset flags to avoid multiple detections
          speedBasedCrashRef.current = false;
          sensorBasedCrashRef.current = false;
        }
        
        // Speed limit checking (every 10 seconds)
        const timeSinceLastCheck = time - lastSpeedCheckTimeRef.current;
        if (timeSinceLastCheck >= 10000) { // 10 seconds
          lastSpeedCheckTimeRef.current = time;
          
          // Fetch speed limit for current location
          getSpeedLimitCached(latitude, longitude).then((limitData: any) => {
            currentSpeedLimitRef.current = limitData.speedLimit;
            setCurrentSpeedLimit(limitData.speedLimit); // Update UI
            
            // Check if currently speeding (5 km/h tolerance)
            const tolerance = 5;
            const isSpeeding = rawSpeed > (limitData.speedLimit + tolerance);
            
            if (isSpeeding && !wasSpeedingRef.current) {
              // Started speeding
              wasSpeedingRef.current = true;
              speedingStartTimeRef.current = time;
              speedingViolationsRef.current += 1;
              setSpeedingViolations(speedingViolationsRef.current); // Update UI
            } else if (!isSpeeding && wasSpeedingRef.current) {
              // Stopped speeding - calculate duration
              wasSpeedingRef.current = false;
              if (speedingStartTimeRef.current) {
                const duration = (time - speedingStartTimeRef.current) / 1000; // seconds
                speedingDurationRef.current += duration;
                speedingStartTimeRef.current = null;
              }
            }
            
            // Track max speed over limit
            if (isSpeeding) {
              const overLimit = rawSpeed - limitData.speedLimit;
              if (overLimit > maxSpeedOverLimitRef.current) {
                maxSpeedOverLimitRef.current = overLimit;
              }
            }
            
            // Log for debugging (optional)
            console.log(`Speed: ${rawSpeed.toFixed(1)} km/h, Limit: ${limitData.speedLimit} km/h (${limitData.source}), Road: ${limitData.roadType || 'unknown'}`);
          }).catch((err: any) => {
            console.warn('Speed limit check failed:', err);
          });
        }
      }
      },
      (error) => {
        setError(`Location error: ${error.message}`);
        console.error('Geolocation error:', error);
      },
      Platform.OS === 'android'
        ? {
            enableHighAccuracy: true,
            distanceFilter: 0,
            interval: 1000,
            fastestInterval: 1000,
            showLocationDialog: false,
            forceRequestLocation: false,
            forceLocationManager: true, // Use legacy API; avoids Fused Location Provider crashes on some devices
          }
        : {
            enableHighAccuracy: true,
            distanceFilter: 0,
            interval: 1000,
            fastestInterval: 1000,
            showsBackgroundLocationIndicator: true,
          }
    );
        watchIdRef.current = watchId;
      } catch (e) {
        console.error('Geolocation.watchPosition failed', e);
        setError(`Failed to start location: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    // Defer so we're not in the same tick as permission state update
    const t = setTimeout(startWatching, 100);

    return () => {
      cancelled = true;
      clearTimeout(t);
      if (watchIdRef.current !== null) {
        try {
          Geolocation.clearWatch(watchIdRef.current);
        } catch (_e) {}
        watchIdRef.current = null;
      }
    };
  }, [permissionGranted]);

  // --- EFFECT 3: Accelerometer subscription (runs once on mount) ---
  useEffect(() => {
    let subscription: { unsubscribe: () => void } | null = null;
    let crashTimeout: ReturnType<typeof setTimeout> | null = null;

    try {
      setUpdateIntervalForType(SensorTypes.accelerometer, 200);
    } catch (e) {
      console.warn('Accelerometer setUpdateIntervalForType failed', e);
    }

    try {
      subscription = accelerometer.subscribe(({ x, y, z }) => {
      // Compute magnitude: |a| = sqrt(x² + y² + z²), orientation-invariant
      const magnitude = Math.sqrt(x * x + y * y + z * z);
      accelerometerMagnitudeRef.current = magnitude;
      
      // Crash detection: |a| > 4g (39 m/s²) indicates crash
      if (magnitude > 39 && tripIdRef.current != null) {
        sensorBasedCrashRef.current = true;
        // Reset flag after 200ms (to detect sustained spike)
        if (crashTimeout) clearTimeout(crashTimeout);
        crashTimeout = setTimeout(() => {
          sensorBasedCrashRef.current = false;
        }, 200);
      }
    });
    } catch (e) {
      console.warn('Accelerometer subscribe failed', e);
    }

    return () => {
      try {
        if (subscription) subscription.unsubscribe();
      } catch (_e) {}
      if (crashTimeout) clearTimeout(crashTimeout);
    };
  }, []);

  /** Haversine formula: distance in km between two lat/lng points. */
  function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /** Check GPS quality based on accuracy and other factors. */
  function isGpsGood(location: any, timeSinceLastUpdate: number): boolean {
    const accuracy = location.coords.accuracy || 999;
    // Good GPS: accuracy <= 20m
    if (accuracy <= 20) return true;
    // Moderate GPS: accuracy <= 30m and reasonable update interval
    if (accuracy <= 30 && timeSinceLastUpdate <= 3000) return true;
    // Otherwise spotty
    return false;
  }

  /** Show mandatory alert once per session; user must tap to open app settings (battery optimization). */
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

  /** Start a new trip: create on backend, set tripId, start tracking, show battery prompt. */
  async function handleStartTrip() {
    if (isStartingTrip) return; // Prevent double-tap and multiple trips
    setError(null);
    const pos = lastLocationRef.current;
    if (!pos) {
      setError('Wait for location');
      return;
    }
    setIsStartingTrip(true);
    try {
      const trip = await createTrip(pos.lat, pos.lng); // POST /api/trips/
      tripIdRef.current = trip.id; // From now on, onLocation will store points in memory
      tripLocationBuffer.current = []; // Reset in-memory buffer
      speedSumRef.current = 0;
      speedCountRef.current = 0;
      harshBrakeCountRef.current = 0;
      harshAccelCountRef.current = 0;
      harshEventsRef.current = []; // Reset harsh events array
      lastHarshBrakeTimeRef.current = 0;
      lastHarshAccelTimeRef.current = 0;
      crashDetectedRef.current = false;
      crashLatRef.current = null;
      crashLngRef.current = null;
      speedBasedCrashRef.current = false;
      sensorBasedCrashRef.current = false;
      speedingDurationRef.current = 0;
      speedingViolationsRef.current = 0;
      maxSpeedOverLimitRef.current = 0;
      lastSpeedCheckTimeRef.current = 0;
      currentSpeedLimitRef.current = null;
      wasSpeedingRef.current = false;
      speedingStartTimeRef.current = null;
      setStatus('driving');
      setSafetyScore(null);
      setHarshBrakeCount(0);
      setHarshAccelerationCount(0);
      setCurrentSpeedLimit(null);
      setSpeedingViolations(0);
      // GPS is already running from app initialization
      
      if (Platform.OS === 'android') {
        try {
          await startForegroundService();
        } catch (_e) {
          // Notification is optional; trip still works without it
        }
        showBatteryPrompt();
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to start trip');
    } finally {
      setIsStartingTrip(false);
      autoStartInProgressRef.current = false;
    }
  }

  /** End the current trip: stop tracking, send end data to backend, show safety score. */
  async function handleEndTrip() {
    if (tripIdRef.current == null) return;
    setError(null);
    const pos = lastLocationRef.current;
    if (!pos) {
      setError('Wait for location');
      return;
    }
    try {
      // Don't stop GPS - keep it running for next trip and to maintain location display
      
      // Finalize speeding duration if currently speeding
      if (wasSpeedingRef.current && speedingStartTimeRef.current) {
        const now = new Date().getTime();
        const duration = (now - speedingStartTimeRef.current) / 1000;
        speedingDurationRef.current += duration;
        wasSpeedingRef.current = false;
      }
      
      const avgSpeed =
        speedCountRef.current > 0
          ? speedSumRef.current / speedCountRef.current
          : speedKmh;
      
      // Compute total distance from buffer (sum of haversine distances)
      let totalDistanceKm = 0;
      const buffer = tripLocationBuffer.current;
      for (let i = 1; i < buffer.length; i++) {
        totalDistanceKm += distanceKm(buffer[i - 1].lat, buffer[i - 1].lng, buffer[i].lat, buffer[i].lng);
      }
      
      const ended = await endTrip( // PATCH /api/trips/:id with end data
        tripIdRef.current,
        pos.lat,
        pos.lng,
        new Date().toISOString(),
        Math.round(avgSpeed * 10) / 10,
        Math.round(totalDistanceKm * 100) / 100, // Round to 2 decimals
        harshBrakeCountRef.current,
        harshAccelCountRef.current,
        crashDetectedRef.current,
        crashLatRef.current,
        crashLngRef.current,
        harshEventsRef.current, // Send harsh events array with locations
        Math.round(speedingDurationRef.current), // Total speeding duration in seconds
        speedingViolationsRef.current, // Number of speeding violations
        Math.round(maxSpeedOverLimitRef.current * 10) / 10 // Max km/h over limit
      );
      setSafetyScore(ended.safety_score ?? 0); // Backend computes score from events + speed
      setStatus('idle');
      tripIdRef.current = null; // onLocation will no longer store points
      tripLocationBuffer.current = []; // Clear in-memory buffer
      harshEventsRef.current = []; // Clear harsh events array
      autoStartInProgressRef.current = false; // Allow auto-start on next drive

      if (Platform.OS === 'android') {
        try {
          await stopForegroundService();
        } catch (_e) {}
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to end trip');
    }
  }

  // --- RENDER ---
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