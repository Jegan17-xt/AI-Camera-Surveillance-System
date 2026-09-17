package in.zynez.superadmin;

import android.app.Notification;
import android.app.NotificationManager;
import android.os.Build;



public class DelegationService extends
        com.google.androidbrowserhelper.trusted.DelegationService {
    @Override
    public void onCreate() {
        super.onCreate();


    }

    // New Lead alert — intercepts ONLY the notification the web app tags
    // "new-lead" (see Frontend/public/firebase-messaging-sw.js's
    // showNotification(title, { tag: "new-lead" }) call) and reposts it on
    // a dedicated HIGH-importance channel with a custom sound/vibration
    // (see LeadAlertChannel) instead of letting it fall through to
    // whatever generic/default channel Chrome's own notification
    // delegation would otherwise use. `platformTag` here is exactly that
    // same JS-side `tag` string, confirmed against the real
    // androidx.browser.trusted.TrustedWebActivityService API this class
    // extends (via com.google.androidbrowserhelper.trusted.DelegationService).
    //
    // Every other notification (any other tag, or this exact tag on a
    // pre-Android-8 device where notification channels don't exist) falls
    // straight through to super's own existing, already-working behavior —
    // completely untouched, so no other FCM/TWA notification is affected.
    //
    // `notification` is the ALREADY-BUILT Notification Chrome handed us —
    // Notification.Builder.recoverBuilder() reconstructs a Builder from it
    // so only the channel is changed; every other field (title, text,
    // icon, and — critically — the contentIntent that opens the existing
    // Leads screen on tap) carries over exactly as Chrome built it. Any
    // failure here (e.g. a NotificationManager quirk on some OEM build)
    // falls back to the default delegation below rather than losing the
    // notification entirely.
    @Override
    public boolean onNotifyNotificationWithChannel(
            String platformTag, int platformId, Notification notification, String channelName) {

        if (LeadAlertChannel.NOTIFICATION_TAG.equals(platformTag)
                && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                LeadAlertChannel.ensureCreated(this);

                Notification rebuilt = Notification.Builder
                        .recoverBuilder(this, notification)
                        .setChannelId(LeadAlertChannel.CHANNEL_ID)
                        .build();

                NotificationManager manager = getSystemService(NotificationManager.class);
                if (manager != null) {
                    manager.notify(platformTag, platformId, rebuilt);
                    return true;
                }
            } catch (Exception e) {
                // Fall through to default delegation below — a broken
                // custom-sound attempt must never mean the lead
                // notification silently fails to show at all.
            }
        }

        return super.onNotifyNotificationWithChannel(platformTag, platformId, notification, channelName);
    }
}

