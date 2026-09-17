package in.zynez.superadmin;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;

/**
 * New Lead alert channel — a dedicated, HIGH-importance Android
 * notification channel with a custom sound + vibration for the existing
 * "New Lead Received" web push (see Frontend/public/firebase-messaging-sw.js,
 * which always tags that notification "new-lead" — DelegationService below
 * matches on that exact tag to redirect ONLY this one notification type
 * through this channel; every other notification keeps going through the
 * TWA's normal default delegation, untouched).
 *
 * Channels are immutable once created — if this ever needs to change
 * (different sound, different importance) after users already have the
 * app installed, it must ship under a NEW channel id, since Android will
 * not update an existing channel's settings for an already-installed app.
 */
final class LeadAlertChannel {

    static final String CHANNEL_ID = "new_leads_channel";
    static final String NOTIFICATION_TAG = "new-lead";

    private LeadAlertChannel() {
    }

    /**
     * Safe to call every time a lead notification arrives, and at app
     * startup — creating an already-existing channel is a documented no-op,
     * so this never resets a user's own per-channel overrides (e.g. if they
     * manually muted it in Android's own notification settings).
     */
    static void ensureCreated(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "New Leads", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Alerts when a new lead is submitted on the website.");
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[]{0, 500, 250, 500});
        channel.enableLights(true);

        Uri soundUri = Uri.parse("android.resource://" + context.getPackageName() + "/raw/lead_alert");
        AudioAttributes audioAttributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        channel.setSound(soundUri, audioAttributes);

        manager.createNotificationChannel(channel);
    }
}
