#!/usr/bin/env bash
set -u

# Use the host GPU (DRI) for Wine's own GL calls instead of the llvmpipe
# software renderer.  llvmpipe is pure-CPU and causes both high CPU usage and
# inflated memory.  The host's /dev/dri is passed through via docker-compose
# so Mesa/DRI hardware rendering is available when Xorg is used.
export MESA_GL_VERSION_OVERRIDE=4.5
# WINEFSYNC uses futex-based synchronisation (kernel ≥ 5.16, esync compatible).
# This replaces the busy-polling done by wineserver and dramatically lowers
# idle CPU.  Kernel 6.12 fully supports it.
export WINEFSYNC=1
export WINESYNC=1

export DISPLAY="${DISPLAY:-:0}"
export WINEPREFIX="${WINEPREFIX:-/opt/wineprefix}"
export WINE_BIN="${WINE_BIN:-/opt/deepin-wine8-stable/bin/wine}"
export WINESERVER_BIN="${WINESERVER_BIN:-/opt/deepin-wine8-stable/bin/wineserver}"
export QUARK_RUNTIME="${QUARK_RUNTIME:-spark}"

echo "=== quark-docker startup ==="
echo "  QUARK_RUNTIME : $QUARK_RUNTIME"
echo "  WINEPREFIX    : $WINEPREFIX"
echo "  WINE_BIN      : $WINE_BIN"
echo "  DISPLAY       : $DISPLAY"
echo "  Running as UID: $(id -u)"

rm -f /tmp/.X0-lock /tmp/.X11-unix/X0
mkdir -p /tmp/.X11-unix /tmp/runtime-wineuser
chmod 1777 /tmp/.X11-unix 2>/dev/null || true
if [ "$(id -u)" = "0" ]; then
    chown wineuser:wineuser /tmp/runtime-wineuser
fi
chmod 700 /tmp/runtime-wineuser
cat > /tmp/runtime-wineuser/asoundrc <<'EOF'
pcm.!default {
    type null
}
EOF
if [ "$(id -u)" = "0" ]; then
    chown wineuser:wineuser /tmp/runtime-wineuser/asoundrc
fi

# Auto-detect VAAPI driver for Intel GPU hardware video acceleration.
echo "--- DRI devices ---"
ls /dev/dri/ 2>/dev/null || echo "  (none)"
if [ -z "${LIBVA_DRIVER_NAME:-}" ]; then
    if [ -f /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so ]; then
        export LIBVA_DRIVER_NAME=iHD    # Gen8+ (Broadwell and newer)
    elif [ -f /usr/lib/x86_64-linux-gnu/dri/i965_drv_video.so ]; then
        export LIBVA_DRIVER_NAME=i965   # Gen4–7 (Sandy/Ivy Bridge)
    fi
fi
if [ -n "${LIBVA_DRIVER_NAME:-}" ]; then
    echo "VAAPI driver  : $LIBVA_DRIVER_NAME"
else
    echo "VAAPI driver  : (not detected)"
fi

# Try hardware-accelerated Xorg (modesetting + DRI3) so Wine's wined3d can
# use the Intel GPU via Mesa/iris.  Fall back to Xvfb if DRI card is absent
# or Xorg fails to start.
#
# Key fixes vs. the previous (white-screen) attempt:
#   - MESA_GL_VERSION_OVERRIDE is unset for real hardware (it was a llvmpipe
#     hack; overriding on real hardware causes extension-set mismatches).
#   - --in-process-gpu is NOT passed so the GPU process is separate; if GPU
#     init fails it crashes independently and the renderer falls back to
#     software instead of hanging the whole browser (white screen).
# Pick the real GPU and pin Xorg to it. This host exposes TWO DRM devices:
# a QEMU/Bochs virtual VGA (PCI 1234:1111, no real 3D) and the actual Intel
# GPU. Left to auto-probe, modesetting selects the virtual VGA as primary and
# Xorg HANGS during glamor init on it ("Driver does not support the 0x1111 PCI
# ID"), wedging the whole X server so x11vnc never binds and Wine can't render.
# Fix: find the first non-virtual card, pin Xorg to its BusID, and disable
# AutoAddGPU/AutoBindGPU so Xorg never touches the virtual VGA as a secondary
# (glamor init on the secondary hangs identically).
_gpu_busid=""
for _card in /sys/class/drm/card[0-9]*; do
    [ -e "$_card/device/vendor" ] || continue
    _v=$(cat "$_card/device/vendor" 2>/dev/null)
    [ "$_v" = "0x1234" ] && continue   # QEMU/Bochs virtual VGA — skip
    _pci=$(basename "$(readlink -f "$_card/device")")   # e.g. 0000:06:10.0
    _bdf=${_pci#*:}; _bus=${_bdf%%:*}; _rest=${_bdf#*:}
    _dev=${_rest%%.*}; _func=${_rest#*.}
    _gpu_busid="PCI:$((16#$_bus)):$((16#$_dev)):$((16#$_func))"
    echo "  Selected GPU  : $_pci (vendor $_v) -> BusID $_gpu_busid"
    break
done

# Generate the Xorg config at runtime (BusID is host-specific). Falls back to
# no BusID line if no real GPU was found, in which case Xvfb takes over below.
_busid_line=""
[ -n "$_gpu_busid" ] && _busid_line="    BusID      \"$_gpu_busid\""
cat > /tmp/xorg-quark.conf <<XORGEOF
Section "ServerFlags"
    Option "AutoAddDevices"  "false"
    Option "AutoEnableDevices" "false"
    Option "AllowEmptyInput" "true"
    Option "DontVTSwitch"    "true"
    Option "AutoAddGPU"      "false"
    Option "AutoBindGPU"     "false"
EndSection

Section "Device"
    Identifier "GPU"
    Driver     "modesetting"
$_busid_line
    Option     "DRI" "3"
EndSection

Section "Monitor"
    Identifier "Monitor0"
    HorizSync   28-80
    VertRefresh 48-75
EndSection

Section "Screen"
    Identifier "Screen0"
    Device     "GPU"
    Monitor    "Monitor0"
    DefaultDepth 24
    SubSection "Display"
        Depth  24
        Modes  "1280x720"
    EndSubSection
EndSection
XORGEOF

_use_hw_xorg=0
if [ -n "$_gpu_busid" ]; then
    echo "--- Starting Xorg (modesetting/DRI3, pinned to $_gpu_busid) ---"
    Xorg :0 -noreset -nolisten tcp -config /tmp/xorg-quark.conf \
         -logfile /tmp/Xorg.0.log &
    _xorg_pid=$!
    _waited=0
    while [ $_waited -lt 8 ] && ! [ -S /tmp/.X11-unix/X0 ]; do
        sleep 1
        _waited=$((_waited + 1))
    done
    if [ -S /tmp/.X11-unix/X0 ]; then
        echo "Xorg started with hardware DRI3 (pid $_xorg_pid)."
        _use_hw_xorg=1
        # Real hardware reports its own GL version — override is not needed.
        unset MESA_GL_VERSION_OVERRIDE
        export MESA_LOADER_DRIVER_OVERRIDE="${MESA_LOADER_DRIVER_OVERRIDE:-iris}"
        echo "  MESA_LOADER_DRIVER_OVERRIDE: $MESA_LOADER_DRIVER_OVERRIDE"
    else
        echo "Xorg failed to start (see /tmp/Xorg.0.log); falling back to Xvfb."
        kill "$_xorg_pid" 2>/dev/null || true
    fi
fi

if [ "$_use_hw_xorg" = "0" ]; then
    echo "--- Starting Xvfb (software fallback) ---"
    Xvfb :0 -screen 0 1024x768x16 -ac -noreset +extension GLX -dpi 96 &
fi
sleep 2
echo "--- Starting x11vnc on :5900 ---"
x11vnc -display :0 -forever -nopw -rfbport 5900 -cursor most -quiet &

# noVNC: bridge the VNC port to a browser over WebSocket. Open
# http://<host>:6080/vnc.html (or just :6080) to reach the desktop without a
# native VNC client. Served only when novnc is installed in the image.
if [ -d /usr/share/novnc ] && command -v websockify >/dev/null 2>&1; then
    echo "--- Starting noVNC (web) on :6080 ---"
    websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 >/tmp/novnc.log 2>&1 &
fi

echo "--- Resolving Quark runtime ---"
if [ "$QUARK_RUNTIME" = "spark" ] && [ -f "/opt/spark-bottle/drive_c/Program Files (x86)/quark-cloud-drive/QuarkCloudDrive.exe" ]; then
    export WINEPREFIX="/opt/spark-bottle"
    EXE="/opt/spark-bottle/drive_c/Program Files (x86)/quark-cloud-drive/QuarkCloudDrive.exe"
    START_LNK="C:\\users\\Public\\Desktop\\夸克网盘.lnk"
    DATA_DIR="$WINEPREFIX/drive_c/users/wineuser/Application Data/quark-cloud-drive"
    DOWNLOADS_DIR="$WINEPREFIX/drive_c/users/wineuser/Downloads"
    echo "  Runtime       : spark bottle"
else
    EXE="$WINEPREFIX/drive_c/users/wineuser/AppData/Local/Programs/QuarkCloudDrive/quark_cloud_drive.exe"
    if [ ! -f "$EXE" ]; then
        EXE="$(find "$WINEPREFIX/drive_c" \( -iname 'quark_cloud_drive.exe' -o -iname 'QuarkCloudDrive.exe' \) 2>/dev/null | grep -v proxy | head -1)"
    fi
    START_LNK=""
    DATA_DIR="$WINEPREFIX/drive_c/users/wineuser/AppData/Local/QuarkCloudDrive"
    DOWNLOADS_DIR="$WINEPREFIX/drive_c/users/wineuser/Downloads"
    echo "  Runtime       : standard wineprefix"
fi
if [ -z "${EXE:-}" ] || [ ! -f "$EXE" ]; then
    echo "ERROR: Quark executable not found"
    tail -f /dev/null
fi
echo "  EXE           : $EXE"
echo "  DATA_DIR      : $DATA_DIR"
echo "  DOWNLOADS_DIR : $DOWNLOADS_DIR"

mkdir -p "$DATA_DIR"
mkdir -p "$DOWNLOADS_DIR"
if [ "$(id -u)" = "0" ]; then
    chown -R wineuser:wineuser "$DATA_DIR"
    chmod -R u+rwX "$DATA_DIR"
    if ! su -s /bin/bash wineuser -c "test -w '$DATA_DIR'"; then
        echo "ERROR: Quark data directory is not writable by wineuser: $DATA_DIR"
        ls -ld "$DATA_DIR"
        tail -f /dev/null
    fi

    # Downloads is a large bind mount (can be tens of GB on a slow HDD). A
    # recursive chown -R here scales with the download history and on an HDD it
    # blocks in uninterruptible I/O for minutes, so the manager never starts and
    # CDP never comes up. Only the directory itself needs to be wineuser-writable
    # so Quark can create new files (which are then owned by wineuser anyway);
    # never touch the existing contents recursively.
    chown wineuser:wineuser "$DOWNLOADS_DIR"
    chmod u+rwX "$DOWNLOADS_DIR"
    if ! su -s /bin/bash wineuser -c "test -w '$DOWNLOADS_DIR'"; then
        echo "ERROR: Quark downloads directory is not writable by wineuser: $DOWNLOADS_DIR"
        ls -ld "$DOWNLOADS_DIR"
        tail -f /dev/null
    fi
fi

echo "--- Launching Wine ---"
echo "  MESA_GL_VERSION_OVERRIDE : ${MESA_GL_VERSION_OVERRIDE:-}"
echo "  WINEFSYNC / WINESYNC     : $WINEFSYNC / $WINESYNC"
echo "Starting Quark: $EXE"

# Auto-detect GPU: if a DRI render node is accessible (passed through via
# docker-compose devices), let Chromium use hardware acceleration through
# Wine's wined3d → Mesa/DRI stack and omit --disable-gpu.
# Without a GPU, fall back to software rendering.
if [ -e /dev/dri/renderD128 ] || [ -e /dev/dri/card0 ]; then
    echo "GPU detected via DRI; enabling hardware acceleration for Chromium."
    _gpu_flags=""
else
    echo "No DRI device found; disabling Chromium GPU acceleration."
    _gpu_flags="--disable-gpu
    --disable-gpu-compositing"
fi

# --in-process-gpu is intentionally omitted: it merges the GPU process into
# the browser process, so a GPU init hang blocks rendering (white screen).
# With a separate GPU process, failures trigger a graceful software fallback.
# The three background-throttling flags (--disable-background-timer-throttling,
# --disable-backgrounding-occluded-windows, --disable-renderer-backgrounding)
# are intentionally NOT set: when the manager minimizes the Quark window we
# want Chromium to actually throttle background tabs to free up CPU.
QUARK_EXTRA_ARGS="
    $_gpu_flags
    --disable-dev-shm-usage
    --renderer-process-limit=1
    --disable-background-networking
    --js-flags=--max-old-space-size=256
"

echo "--- Launching server (API on :${QUARK_API_PORT:-8080}) ---"
# The server owns: the oRPC API, the in-process CDP proxy (9223 → 9222), and
# the thin process manager. It will exec launch-quark.sh to start the actual
# Quark process group; that one lives in its own session so we can kill it
# cleanly.
if ! command -v deno >/dev/null 2>&1; then
    echo "ERROR: deno is required for the server"
    tail -f /dev/null
fi
export EXE
export START_LNK
export WINEPREFIX
export WINEDEBUG
export WINE_BIN
export WINESERVER_BIN
export QUARK_EXTRA_ARGS
export WINEFSYNC
export WINESYNC
export LIBVA_DRIVER_NAME

# ── First-boot prefix initialization (durability fix) ───────────────────────
# deepin-wine8 runs the 32-bit QuarkCloudDrive.exe through new-style WoW64,
# which needs the wow64*.dll builtin symlinks under system32. Those are created
# by `wineboot --init` on first boot. The baked spark-bottle prefix does NOT
# ship them, and they live in the container's writable layer, so a
# `docker compose up` recreate wipes them. If the init is left to happen lazily
# on the manager's first Quark launch, a slow init races the idle-monitor /
# cdp-client restart cycle: each restart's `wineserver -k` kills the in-flight
# wineboot before it finishes, so the symlinks never appear and Quark dies with
#   err:module:init_wow64 could not load wow64.dll  (status c0000135).
# Do ONE blocking init here, before the manager (hence before any launch), so
# Quark always starts against a fully-initialized prefix.
_wow64="$WINEPREFIX/drive_c/windows/system32/wow64.dll"
if [ ! -e "$_wow64" ]; then
    echo "--- Initializing wineprefix (wineboot --init) ---"
    su -s /bin/bash wineuser -c "\
        WINEPREFIX='$WINEPREFIX' DISPLAY='$DISPLAY' \
        XDG_RUNTIME_DIR=/tmp/runtime-wineuser WINEDEBUG=-all \
        WINEFSYNC='${WINEFSYNC:-1}' WINESYNC='${WINESYNC:-1}' \
        '$WINE_BIN' wineboot --init" >/tmp/wineboot-init.log 2>&1 &
    _bpid=$!
    # CRITICAL: wait for wineboot to FULLY finish before doing anything else.
    # The wow64 symlink appears within ~2s but the rest of the init (registry,
    # services, more builtins) is still running; tearing the wineserver down at
    # that point leaves a half-initialized prefix that Quark fails to launch
    # against. Block on the wineboot process itself (bounded).
    _w=0
    while [ $_w -lt 120 ] && kill -0 "$_bpid" 2>/dev/null; do
        sleep 1; _w=$((_w + 1))
    done
    if kill -0 "$_bpid" 2>/dev/null; then
        echo "  WARNING: wineboot --init still running after ${_w}s; continuing anyway."
    elif [ -e "$_wow64" ]; then
        echo "  wineprefix initialized (wineboot finished in ${_w}s, wow64 builtins present)."
    else
        echo "  WARNING: wineboot finished but wow64.dll missing; Quark may fail to launch."
        tail -5 /tmp/wineboot-init.log 2>/dev/null
    fi
    # Now that init has fully completed, reset the bootstrap wineserver so the
    # manager's first launch starts from a clean, ready prefix.
    su -s /bin/bash wineuser -c "WINEPREFIX='$WINEPREFIX' '$WINESERVER_BIN' -k" 2>/dev/null || true
    sleep 1
fi

# Mesa env-vars: pass through; launch-quark.sh unsets them if empty.
cd /opt/quark-server
exec deno run -A /opt/quark-server/apps/server/src/main.ts
