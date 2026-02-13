/**
 * Foreground service module for Android trip tracking.
 * Starts foreground service when trip begins, stops when trip ends.
 * Displays "Telematics Safety - Trip Active" notification during trip.
 * Delegates to NotificationService (Notifee) for implementation.
 */
import NotificationService from './NotificationService';

export async function startForegroundService(): Promise<void> {
  await NotificationService.showTripActiveNotification();
}

export async function stopForegroundService(): Promise<void> {
  await NotificationService.cancelAll();
}
