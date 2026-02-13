import { Platform } from 'react-native';
import notifee, { AndroidImportance, AndroidForegroundServiceType } from '@notifee/react-native';

const CHANNEL_ID = 'trip-tracking';
const NOTIFICATION_ID = 'trip-tracking-notification';

/**
 * Notification service for foreground service on Android
 * Displays persistent notification during active trips
 */
class NotificationService {
  private isChannelCreated = false;

  /**
   * Initialize notification channel (Android only)
   * Must be called before displaying notifications
   */
  async initialize(): Promise<void> {
    if (Platform.OS !== 'android') return;
    try {
      if (!this.isChannelCreated) {
        await notifee.createChannel({
          id: CHANNEL_ID,
          name: 'Trip Tracking',
          importance: AndroidImportance.DEFAULT,
          description: 'Shows when a trip is being tracked',
        });
        this.isChannelCreated = true;
      }
    } catch (e) {
      console.warn('NotificationService: createChannel failed', e);
    }
  }

  /**
   * Display notification for active trip (starts foreground service)
   * Android 14+ requires foregroundServiceTypes to be set.
   */
  async showTripActiveNotification(): Promise<void> {
    if (Platform.OS !== 'android') return;
    try {
      await this.initialize();

      await notifee.displayNotification({
        id: NOTIFICATION_ID,
        title: 'Telematics Safety - Trip Active',
        body: 'Recording your trip. Tracking location and driving events.',
        android: {
          channelId: CHANNEL_ID,
          importance: AndroidImportance.DEFAULT,
          ongoing: true,
          asForegroundService: true,
          foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_LOCATION],
          smallIcon: 'ic_launcher',
          // Avoid pressAction that might crash on some devices
        },
      });
    } catch (e) {
      console.warn('NotificationService: showTripActiveNotification failed', e);
    }
  }

  /**
   * Update notification to standby mode
   */
  async showStandbyNotification(): Promise<void> {
    if (Platform.OS !== 'android') return;
    try {
      await this.initialize();
      await notifee.displayNotification({
        id: NOTIFICATION_ID,
        title: 'Telematics Safety - Standby',
        body: 'Ready to track trips. Start a trip to begin tracking.',
        android: {
          channelId: CHANNEL_ID,
          importance: AndroidImportance.LOW,
          ongoing: false,
          smallIcon: 'ic_launcher',
        },
      });
    } catch (e) {
      console.warn('NotificationService: showStandbyNotification failed', e);
    }
  }

  /**
   * Cancel all notifications (stops foreground service)
   */
  async cancelAll(): Promise<void> {
    if (Platform.OS !== 'android') return;
    try {
      await notifee.cancelNotification(NOTIFICATION_ID);
    } catch (e) {
      console.warn('NotificationService: cancelAll failed', e);
    }
  }
}

export default new NotificationService();
