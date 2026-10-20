# syntax=docker/dockerfile:1
# app — the single image for the whole app.
#
# One container, one entrypoint: the Wine/Electron Quark host plus the Bun
# runtime that owns process management, the CDP proxy, the manager API, the
# business API/MCP surface, the noVNC page and the idle policy. There is no
# separate client container and no runtime split.
#
# Build context must be the repository root (the Dockerfile copies the whole
# workspace so the @quark/* packages resolve). The 1.3 GB wineprefix.tar.zst is
# a build artifact (gitignored); keep it under app/.
# The runtime ships as a static binary copied out of the official image, so the
# app keeps the Wine base and gains no second distribution.
FROM oven/bun:1.4.3 AS bun

FROM scottyhardy/docker-wine:latest AS base

# Common runtime for both the manual installer environment and the final image.
# Quark's current Chromium build exits with status 5 under Wine 11 in this
# image. The old AUR package uses deepin-wine8-stable, so keep that runtime
# available and run Quark through it.
ENV RDP_SERVER=no \
    TZ=Asia/Shanghai \
    USER_UID=1000 \
    USER_GID=1000 \
    LANG=zh_CN.UTF-8 \
    LANGUAGE=zh_CN:zh \
    LC_ALL=zh_CN.UTF-8 \
    WINEPREFIX=/opt/wineprefix \
    WINEARCH=win64 \
    WINEDEBUG=-all \
    DISPLAY=:0 \
    WINE_BIN=/opt/deepin-wine8-stable/bin/wine \
    WINESERVER_BIN=/opt/deepin-wine8-stable/bin/wineserver

# WINEDLLOVERRIDES is not set globally because the installer may need mscoree.
# Suppress Mono/Gecko only during wineboot in the prepare script.
RUN --mount=type=bind,source=app/.deb-cache/deepin-wine8.deb,target=/tmp/deepin-wine8.deb \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        fonts-wqy-microhei \
        fonts-wqy-zenhei \
        locales \
        x11vnc \
        xdotool \
        zstd \
        p7zip-full \
        curl \
        ca-certificates \
        libdrm2 \
        libva2 \
        libva-drm2 \
        libva-x11-2 \
        libgl1-mesa-dri \
        intel-media-va-driver \
        i965-va-driver \
        xserver-xorg-core \
        libasound2-plugins \
        libcapi20-3 \
        libgstreamer1.0-0 \
        libgstreamer-plugins-base1.0-0 \
        libpulse0 \
        libsdl2-2.0-0 \
        libwayland-client0 \
        libxcomposite1 \
        libxcursor1 \
        libxfixes3 \
        libxi6 \
        libxinerama1 \
        libxrandr2 \
        libxrender1 \
        libxxf86vm1 \
    && locale-gen zh_CN.UTF-8 \
    && dpkg-deb -x /tmp/deepin-wine8.deb / \
    && rm -rf /var/lib/apt/lists/* \
    && (getent group 1000 >/dev/null || groupadd -g 1000 wineuser) \
    && (id -u wineuser >/dev/null 2>&1 || useradd -u 1000 -g 1000 -m -s /bin/bash wineuser) \
    && mkdir -p /opt/wineprefix /tmp/.X11-unix \
    && chown wineuser:wineuser /opt/wineprefix \
    && chmod 1777 /tmp/.X11-unix \
    && mkdir -p /etc/X11 \
    && cat > /etc/X11/xorg-headless.conf <<'XORGEOF'
Section "ServerFlags"
    Option "AutoAddDevices"  "false"
    Option "AutoEnableDevices" "false"
    Option "AllowEmptyInput" "true"
    Option "DontVTSwitch"    "true"
EndSection

Section "Device"
    Identifier "GPU"
    Driver     "modesetting"
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

# Bun runtime for the whole app. Pinned: every migration spike, the test suite
# and the CDP proxy's socket behaviour were verified against this exact release.
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun /usr/local/bin/bunx /usr/local/bin/bunx

FROM base AS install-debug

COPY --chown=wineuser:wineuser ./private/installer.exe /tmp/installer.exe
COPY --chown=wineuser:wineuser ./app/cjk-fonts.reg /tmp/cjk-fonts.reg

USER root

CMD rm -f /tmp/.X0-lock /tmp/.X11-unix/X0 && \
    Xvfb :0 -screen 0 1024x768x16 -ac & \
    sleep 2 && \
    x11vnc -display :0 -forever -nopw -rfbport 5900 -cursor most -quiet & \
    tail -f /dev/null

FROM base AS runtime

RUN --mount=type=bind,source=app/wineprefix.tar.zst,target=/tmp/wineprefix.tar.zst \
    --mount=type=bind,source=app/.deb-cache/quark-spark.deb,target=/tmp/quark-spark.deb \
    rm -rf /opt/wineprefix && \
    mkdir -p /opt/wineprefix && \
    tar --zstd -xf /tmp/wineprefix.tar.zst -C /opt/wineprefix && \
    mkdir -p /tmp/quark-spark /opt/spark-bottle && \
    dpkg-deb -x /tmp/quark-spark.deb /tmp/quark-spark && \
    7z x -y -o/opt/spark-bottle /tmp/quark-spark/opt/apps/cn.quarkclouddrive.spark/files/files.7z; \
    rc=$?; ([ "$rc" -eq 0 ] || [ "$rc" -eq 2 ]) && \
    rm -rf /opt/spark-bottle/drive_c/users/wineuser && \
    cp -a /opt/spark-bottle/drive_c/users/@current_user@ /opt/spark-bottle/drive_c/users/wineuser && \
    mkdir -p /opt/spark-bottle/dosdevices && \
    ln -sfn ../drive_c /opt/spark-bottle/dosdevices/c: && \
    ln -sfn / /opt/spark-bottle/dosdevices/z: && \
    chown -R wineuser:wineuser /opt/wineprefix && \
    chown -R wineuser:wineuser /opt/spark-bottle && \
    rm -rf /tmp/quark-spark

COPY ./app/scripts/run-quark.sh /usr/local/bin/run-quark.sh
COPY ./app/scripts/launch-quark.sh /usr/local/bin/launch-quark.sh
COPY ./app/scripts/configure-quark-settings.ts /usr/local/bin/configure-quark-settings.ts

# The app + workspace sources. The image runs with cwd=/opt/quark-app, which is
# also where the KV file lands by default (./data/kv.sqlite3).
WORKDIR /opt/quark-app

# Manifests first, so the dependency layer only rebuilds when one of them moves.
# playwright is a runtime dependency (CDP attach) but never launches a browser,
# so the browser download is skipped.
COPY ./package.json ./bun.lock /opt/quark-app/
COPY ./app/package.json /opt/quark-app/app/package.json
COPY ./packages/config/package.json /opt/quark-app/packages/config/package.json
COPY ./packages/contract/package.json /opt/quark-app/packages/contract/package.json
COPY ./packages/drive/package.json /opt/quark-app/packages/drive/package.json
COPY ./packages/manager/package.json /opt/quark-app/packages/manager/package.json
COPY ./packages/service/package.json /opt/quark-app/packages/service/package.json
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN bun install --frozen-lockfile --production

# Only the runtime sources. The 1.3 GB wineprefix.tar.zst is bind-mounted from
# the build context above, and private/installer.exe/.deb-cache are build-time only, so
# baking ./app wholesale would add ~1.5 GB to the image for nothing.
COPY ./app/src /opt/quark-app/app/src
COPY ./app/download-client.ts /opt/quark-app/app/download-client.ts
COPY ./packages /opt/quark-app/packages

RUN chmod +x /usr/local/bin/run-quark.sh \
                /usr/local/bin/launch-quark.sh

# Ports: 3000 public API + manager API + OpenAPI + MCP + noVNC page,
# 9223 CDP proxy, 5900 raw VNC (x11vnc).

USER root

EXPOSE 3000 5900 9223

ENTRYPOINT ["/usr/local/bin/run-quark.sh"]

# Development reuses the exact Wine/runtime layer, but runs the bind-mounted
# workspace through the Bun dev supervisor. Production is kept as the final
# stage so a plain `docker build` still produces the runtime image.
FROM runtime AS dev
COPY ./app/scripts/dev-entrypoint.sh /usr/local/bin/dev-entrypoint.sh
COPY ./app/scripts/dev-client.ts /opt/quark-app/app/scripts/dev-client.ts
RUN chmod +x /usr/local/bin/dev-entrypoint.sh && \
    bun install --frozen-lockfile
ENV QUARK_DEV=1

FROM runtime AS production
