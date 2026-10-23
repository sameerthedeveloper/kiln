# macOS signing and notarization

The release workflow signs and notarizes the macOS builds when all five secrets below exist.
Without them it still publishes, but the macOS apps are unsigned and macOS shows "Kiln is damaged".

## Get the credentials

1. Join the Apple Developer Program (paid, per year).
2. In Xcode, Settings > Accounts > Manage Certificates, create a **Developer ID Application** certificate.
3. In Keychain Access, export it as a `.p12` file and set a password.
4. At appleid.apple.com, create an **app-specific password**.
5. Find your **Team ID** at developer.apple.com/account, under Membership details.

## Add the repo secrets

Settings > Secrets and variables > Actions, or with the GitHub CLI:

```
base64 -i certificate.p12 | gh secret set APPLE_CERTIFICATE
gh secret set APPLE_CERTIFICATE_PASSWORD   # the .p12 password
gh secret set APPLE_ID                     # Apple ID email
gh secret set APPLE_PASSWORD               # the app-specific password
gh secret set APPLE_TEAM_ID                # 10-character team ID
```

## Release

Push a tag such as `v0.1.1`. Check the macOS jobs log for "Signing" and "Notarizing".
Once signed builds ship, remove the `xattr` note from `landing/index.html`.
