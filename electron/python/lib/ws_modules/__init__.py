"""WebSocket-driven module handlers loaded by lib.ws_module_adapter.

Every file in this directory exports a `run(device, config)` coroutine that
lib.ws_module_adapter wires into the WS_ADAPTED_MODULES registry. Each module
is independent and uses lib.ws_modules_shared for cross-cutting helpers.

The docstring is intentional: a previously-empty __init__.py let
PyInstaller skip bundling this package's root, so the frozen brain raised
"No module named 'lib.ws_modules'" at runtime even though individual
submodules were present in the archive. Non-empty content + explicit
hidden imports in server.spec keeps the package itself in the bundle.
"""
