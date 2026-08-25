# VYNTRA Agent on macOS and iOS

## macOS

macOS requires a separate native build. A Windows `.exe` cannot run as a macOS
app. Build on a Mac with:

```bash
cd /path/to/VYNTRA
COMPANY_NAME="InsureMeBetter" \
CONTACT_EMAIL="carlos@insuremebetter.com" \
API_URL="https://api.vyntralab.com" \
LANGUAGE="es" \
bash installer/build_macos_app.sh
```

The result is:

```text
release/VYNTRAAgent-InsureMeBetter-macOS.zip
```

The user extracts the ZIP and runs:

```text
Install VYNTRA Agent.command
```

macOS will require user-approved permissions for Screen Recording and possibly
Accessibility. Without those permissions, the app may open but screenshots or
activity signals can be incomplete.

For production distribution on macOS, the app should be code-signed and
notarized with an Apple Developer account.

## iOS

iOS does not allow a third-party app to monitor other apps, capture the screen in
the background, inspect active window titles, or run a persistent desktop-style
agent. For iPhone/iPad, VYNTRA would need a different product scope, such as a
manual clock-in/clock-out app, MDM-managed controls, or integration with Apple
Business Manager. It cannot be the same monitored desktop agent used on Windows
or macOS.

