/**
 * @format
 */

jest.mock('react-native-geolocation-service', () => ({
  watchPosition: jest.fn(() => 1),
  clearWatch: jest.fn(),
}));

jest.mock('react-native-sensors', () => ({
  accelerometer: {
    subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })),
  },
  SensorTypes: {
    accelerometer: 'accelerometer',
  },
  setUpdateIntervalForType: jest.fn(),
}));

jest.mock('../api', () => ({
  createTrip: jest.fn(),
  addLocationPoint: jest.fn(),
  endTrip: jest.fn(),
}));

jest.mock('../speedLimitService', () => ({
  getSpeedLimitCached: jest.fn(() =>
    Promise.resolve({ speedLimit: 50, source: 'test', roadType: 'test' })
  ),
}));

jest.mock('../ForegroundService', () => ({
  startForegroundService: jest.fn(),
  stopForegroundService: jest.fn(),
}));

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SafeAreaView: ({ children, ...props }: { children: React.ReactNode }) => (
      <View {...props}>{children}</View>
    ),
  };
});

import App from '../App';

test('App module loads', () => {
  expect(App).toBeDefined();
});
