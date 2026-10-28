# Closed networks and offline machines

AiN's package carries everything it runs on (speech recognition and synthesis are linked in, from
sherpa-onnx's static libraries); only the AI models are downloaded, once, when you ask.

## Certificates

Every connection (AI providers, the community store, model downloads, updates, PersonaPlex) checks
the server's certificate against the **system's trust store**. A company CA installed on the machine
is trusted, as by the browser:

```sh
sudo cp company-ca.pem /etc/pki/ca-trust/source/anchors/   # Fedora
sudo update-ca-trust
```

For servers with a self-signed certificate, turn on **Settings → General → Network → Accept any
certificate**, or start AiN with `AIN_INSECURE_TLS=1`. Certificates are then not checked at all:
anyone on the network could read and change the traffic. Use it on a network you trust only.

## Models without internet

Set **Settings → General → Network → Models source** (or `AIN_MODELS_SOURCE`, which wins) to a
folder, a `file://` URL or an `http(s)://` address laid out like AiN's models folder. **Download**
then takes each model from there, checked against the same pinned hashes.

| Model | Expected in the source |
| --- | --- |
| Speech model (dictation) | `<folder>/<file>`, e.g. `parakeet-tdt-0.6b-v3-int8/encoder.int8.onnx` |
| Voice (read aloud) | `<folder>.tar.bz2` as published by sherpa-onnx, or `<folder>/` already unpacked |

To make one, download the models in AiN on a connected computer, then copy its models folder (the
folder icon in each model's card opens it) to a USB drive, a network share or a web server.
Copying model folders straight into the offline machine's models folder works too.
