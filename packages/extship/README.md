# extship

**Publish a browser extension to the Chrome Web Store from CI, with a short-lived access token.**

```sh
CHROME_WEB_STORE_ACCESS_TOKEN=… npx extship chrome publish --publisher-id <id> --item-id <id> --zip extension.zip
```

See the [extship README](https://github.com/fishballapp/extship#readme) for what `publish` does, the
CLI contract, the keyless Google Cloud setup and a GitHub Actions example.
