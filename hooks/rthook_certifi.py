"""
PyInstaller runtime hook — inject certifi's CA bundle into the SSL environment.

On macOS, a PyInstaller-bundled Python can't reach the system certificate store
(the dyld sandbox and _MEIPASS isolation block the usual /etc/ssl lookup).
Setting SSL_CERT_FILE before any SSL socket opens fixes
ssl.create_default_context() and the `requests` library at once.

Windows already ships its own trust store and Python's ssl module uses it
natively; this hook is a no-op there (certifi.where() still points to a valid
file, so no harm is done).
"""
import os

try:
    import certifi
    cert_file = certifi.where()
    os.environ.setdefault("SSL_CERT_FILE", cert_file)
    os.environ.setdefault("REQUESTS_CA_BUNDLE", cert_file)
except Exception:
    pass
