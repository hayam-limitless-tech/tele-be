//location done v1
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
import BackgroundGeolocation from 'react-native-background-geolocation';
import {
  createTrip,
  addLocationPoint,
  endTrip,
} from './api';

type TripStatus = 'idle' | 'driving';

function App() {
  // --- STATE (drives UI re-renders) ---
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [status, setStatus] = useState<TripStatus>('idle');
  const [speedKmh, setSpeedKmh] = useState(0);
  const [safetyScore, setSafetyScore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [harshBrakeCount, setHarshBrakeCount] = useState(0);

  // --- REFS (persist across renders, used in callbacks without causing re-renders) ---
  const tripIdRef = useRef<number | null>(null); // Backend trip ID when driving
  const lastLocationRef = useRef<{ lat: number; lng: number; time: number } | null>(null); // Last GPS point for speed calc + start/end
  const speedSumRef = useRef(0); // Running sum of speeds for average (end trip)
  const speedCountRef = useRef(0); // Count of speed samples
  const batteryPromptShownRef = useRef(false); // Show battery prompt only once per session

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

  // --- EFFECT 2: Configure BackgroundGeolocation and subscribe to location (runs when permission granted) ---
  useEffect(() => {
    if (!permissionGranted) return;

    // Configure the library: 1s interval (iOS: no notification; Android: low-priority notification), high accuracy
    BackgroundGeolocation.ready({
      foregroundService: true,
      notification: {
        priority: BackgroundGeolocation.NotificationPriority.Min,
        title: 'Trip in progress',
        text: 'Recording your trip',
      },
      distanceFilter: 0,
      locationUpdateInterval: 1000,
      desiredAccuracy: BackgroundGeolocation.DesiredAccuracy.High,
      stopOnTerminate: false,
    } as Parameters<typeof BackgroundGeolocation.ready>[0]);

    // Subscribe to location updates (~every 1s). Called even when app is in background.
    const subscription = BackgroundGeolocation.onLocation((location) => {
      setError(null); // Clear any previous error
      const latitude = location.coords.latitude;
      const longitude = location.coords.longitude;
      const time = new Date(location.timestamp).getTime(); // ms for arithmetic

      // Compute speed from distance between this point and previous
      const prev = lastLocationRef.current;
      let speed = 0;
      if (prev) {
        const distKm = distanceKm(prev.lat, prev.lng, latitude, longitude);
        const timeHours = (time - prev.time) / 1000 / 3600;
        speed = timeHours > 0 ? distKm / timeHours : 0;
        setSpeedKmh(Math.round(speed * 10) / 10);
        speedSumRef.current += speed; // Accumulate for average at end of trip
        speedCountRef.current += 1;
      }
      lastLocationRef.current = { lat: latitude, lng: longitude, time };

      // If we're on an active trip, send this point to the backend
      if (tripIdRef.current != null) {
        addLocationPoint(tripIdRef.current, latitude, longitude, 0).catch(() => {});
      }
    });

    return () => {
      subscription.remove(); // Unsubscribe when permission revoked or component unmounts
    };
  }, [permissionGranted]);

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

  /** Show mandatory alert once per session; user must tap to open app settings (battery optimization). */
  function showBatteryPrompt() {
    if (batteryPromptShownRef.current) return;
    batteryPromptShownRef.current = true;
    Alert.alert(
      'Required for tracking',
      'Turn off battery optimization for reliable tracking when the app is in the background. You must open settings to continue.',
      [{ text: 'Open settings', onPress: () => Linking.openSettings() }]
    );
  }

  /** Start a new trip: create on backend, set tripId, start tracking, show battery prompt. */
  async function handleStartTrip() {
    setError(null);
    const pos = lastLocationRef.current;
    if (!pos) {
      setError('Wait for location'); // Need at least one location before starting
      return;
    }
    try {
      const trip = await createTrip(pos.lat, pos.lng); // POST /api/trips/
      tripIdRef.current = trip.id; // From now on, onLocation will send points to this trip
      speedSumRef.current = 0;
      speedCountRef.current = 0;
      setStatus('driving');
      setSafetyScore(null);
      setHarshBrakeCount(0);
      BackgroundGeolocation.start(); // Start receiving location updates (continues in background)
      if (Platform.OS === 'android') showBatteryPrompt();
    } catch (e: any) {
      setError(e?.message || 'Failed to start trip');
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
      BackgroundGeolocation.stop(); // Stop location updates
      const avgSpeed =
        speedCountRef.current > 0
          ? speedSumRef.current / speedCountRef.current
          : speedKmh;
      const ended = await endTrip( // PATCH /api/trips/:id with end data
        tripIdRef.current,
        pos.lat,
        pos.lng,
        new Date().toISOString(),
        Math.round(avgSpeed * 10) / 10
      );
      setSafetyScore(ended.safety_score ?? 0); // Backend computes score from events + speed
      setStatus('idle');
      tripIdRef.current = null; // onLocation will no longer send points
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
        {status === 'driving' && (
          <View style={styles.row}>
            <Text style={styles.label}>Harsh brakes this trip:</Text>
            <Text style={[styles.value, styles.harshBrake]}>{harshBrakeCount}</Text>
          </View>
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
            <TouchableOpacity style={styles.button} onPress={handleStartTrip}>
              <Text style={styles.buttonText}>Start trip</Text>
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