# Android App Setup (Capacitor)

This project can be packaged as an Android app.

## 1) Install dependencies

```bash
npm install
```

## 2) Add Android project (one time)

```bash
npm run cap:add:android
```

## 3) Sync web code into Android

```bash
npm run cap:sync
```

## 4) Open in Android Studio

```bash
npm run cap:open:android
```

Then build APK/AAB from Android Studio.

## Notes

- Native app uses this backend by default:
  - `https://tests-vw1q.onrender.com`
- You can override server URL by opening app/web with:
  - `?server=https://your-server-domain.com`
- URL is saved in local storage key:
  - `remote_support_server_url`
- App starts a foreground keep-alive service with persistent notification.
- On Android 13+, allow notification permission for stable foreground service visibility.
- Exclude app from battery optimization for better background reliability.
