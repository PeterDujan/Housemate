# Debian Python (torch, speechbrain and vosk need glibc wheels) plus Node for the brain. The base is
# named here because this Supervisor passes its own Alpine BUILD_FROM regardless of build.yaml.
FROM python:3.14-slim-trixie

ARG NODE_VERSION=22.22.2
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# ffmpeg decodes voices and browser audio; espeak-ng is the voice of last resort; gcc builds
# webrtcvad and leaves again in the same layer.
COPY voice-requirements.lock /tmp/voice-requirements.lock
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg espeak-ng gcc libc6-dev curl xz-utils ca-certificates \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
       | tar -xJ -C /usr/local --strip-components=1 \
    && pip install -r /tmp/voice-requirements.lock \
    && npm install -g @anthropic-ai/claude-code@2.1.300 @openai/codex@0.144.1 \
    && apt-get purge -y gcc libc6-dev xz-utils \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /tmp/voice-requirements.lock /root/.npm

WORKDIR /opt/housemate/brain
COPY brain/package.json brain/package-lock.json ./
RUN npm ci && rm -rf /root/.npm
COPY brain ./
RUN npm run build && npm prune --omit=dev && rm -rf /root/.npm

COPY voice /opt/housemate/voice
COPY run.py /opt/housemate/run.py

WORKDIR /opt/housemate
CMD ["python3", "/opt/housemate/run.py"]
