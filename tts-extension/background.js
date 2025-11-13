const AUDIO_FORMAT = 'mp3';
const MAX_TOTAL_CHARS = 8000;
const CHUNK_SIZE = 1800;
const DEFAULT_VOICE = 'Joanna';
const CHINESE_VOICE = 'Zhiyu';
const CHINESE_LANGUAGE_CODE = 'cmn-CN';
const DEFAULT_REGION = 'us-east-1';
const AWS_SERVICE = 'polly';
const AWS_ALGORITHM = 'AWS4-HMAC-SHA256';
const POLLY_PATH = '/v1/speech';
const DEFAULT_SPEECH_RATE = '1';
const SPEECH_RATE_LOOKUP = {
  '0.75': '75%',
  '1': '100%',
  '1.25': '125%'
};

const activeNarrations = new Map(); // tabId -> {controller, cancelled}
const textEncoder = new TextEncoder();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender?.tab?.id;

  if (!tabId) {
    return;
  }

  if (message?.type === 'startNarration') {
    handleStartNarration(tabId, message).catch((error) => {
      console.error('Narration error', error);
      notifyTab(tabId, {
        type: 'tts-error',
        error: error.message || 'Failed to start narration.'
      });
    });
  }

  if (message?.type === 'stopNarration') {
    stopNarration(tabId, 'Stopped by user');
  }
});

async function handleStartNarration(tabId, payload) {
  if (activeNarrations.has(tabId)) {
    stopNarration(tabId, 'Starting a new request');
  }

  const cleanText = (payload.text || '').slice(0, MAX_TOTAL_CHARS);
  if (!cleanText.trim()) {
    notifyTab(tabId, {
      type: 'tts-error',
      error: 'No readable text found on this page.'
    });
    return;
  }

  const settings = await getSettings();
  const accessKeyId = settings.accessKeyId;
  const secretAccessKey = settings.secretAccessKey;
  const region = settings.region || DEFAULT_REGION;
  const voice = settings.voice || DEFAULT_VOICE;
  const speechRate = normalizeSpeechRate(payload.speechRate || settings.speechRate);
  if (!accessKeyId || !secretAccessKey) {
    notifyTab(tabId, {
      type: 'tts-error',
      error: 'Add your AWS access key and secret in the extension options first.'
    });
    return;
  }

  const controller = new AbortController();
  const narrationState = { controller, cancelled: false };
  activeNarrations.set(tabId, narrationState);

  notifyTab(tabId, {
    type: 'tts-status',
    status: 'Processing text...'
  });

  try {
    let chunkIndex = 0;
    for (const chunk of chunkText(cleanText)) {
      if (narrationState.cancelled) {
        break;
      }

      notifyTab(tabId, {
        type: 'tts-status',
        status: `Generating audio (${chunkIndex + 1})...`
      });

      const voiceConfig = selectVoiceForText(voice, chunk);
      const base64Audio = await requestSpeechChunk({
        accessKeyId,
        secretAccessKey,
        region,
        voice: voiceConfig.voiceId,
        languageCode: voiceConfig.languageCode,
        text: prefixChunk(chunkIndex, payload.title, payload.url, chunk),
        speechRate,
        signal: controller.signal
      });

      notifyTab(tabId, {
        type: 'tts-audio-chunk',
        chunkIndex,
        base64Audio,
        format: AUDIO_FORMAT
      });

      chunkIndex += 1;
    }

    const wasCancelled = narrationState.cancelled;
    stopNarration(tabId);

    if (!wasCancelled) {
      notifyTab(tabId, {
        type: 'tts-complete'
      });
    }
  } catch (error) {
    console.error('Narration failure', error);
    stopNarration(tabId);
    if (error.name === 'AbortError') {
      notifyTab(tabId, {
        type: 'tts-status',
        status: 'Narration cancelled.'
      });
      return;
    }
    notifyTab(tabId, {
      type: 'tts-error',
      error: error.message || 'Failed to generate audio.'
    });
  }
}

function stopNarration(tabId, reason = '') {
  const narration = activeNarrations.get(tabId);
  if (!narration) {
    return;
  }

  narration.cancelled = true;
  narration.controller.abort();
  activeNarrations.delete(tabId);

  if (reason) {
    notifyTab(tabId, {
      type: 'tts-status',
      status: reason
    });
  }
}

async function requestSpeechChunk({
  accessKeyId,
  secretAccessKey,
  region,
  voice,
  languageCode,
  text,
  speechRate,
  signal
}) {
  const url = `https://polly.${region}.amazonaws.com${POLLY_PATH}`;
  const ssmlPayload = buildSsmlPayload(text, speechRate);
  const payload = JSON.stringify({
    Text: ssmlPayload,
    TextType: 'ssml',
    OutputFormat: AUDIO_FORMAT,
    VoiceId: voice,
    ...(languageCode ? { LanguageCode: languageCode } : {})
  });

  const signedRequest = await signAwsRequest({
    method: 'POST',
    url,
    region,
    accessKeyId,
    secretAccessKey,
    payload
  });

  signedRequest.headers.Accept = 'audio/mpeg';

  const response = await fetch(url, {
    method: 'POST',
    headers: signedRequest.headers,
    body: payload,
    signal
  });

  if (!response.ok) {
    const errorDetail = await safeReadError(response);
    throw new Error(`Amazon Polly failed (${response.status}): ${errorDetail}`);
  }

  const buffer = await response.arrayBuffer();
  return arrayBufferToBase64(buffer);
}

async function safeReadError(response) {
  try {
    const text = await response.text();
    try {
      const data = JSON.parse(text);
      return data?.message || data?.error?.message || response.statusText;
    } catch (error) {
      return text || response.statusText;
    }
  } catch (error) {
    return response.statusText;
  }
}

function chunkText(text = '') {
  const chunks = [];
  let current = '';
  const sentences = text.split(/(?<=[.!?])\s+/);

  const pushCurrent = () => {
    if (current.trim()) {
      chunks.push(current.trim());
      current = '';
    }
  };

  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
    if (!sentence) {
      continue;
    }

    if (sentence.length > CHUNK_SIZE) {
      pushCurrent();
      for (const piece of splitLongText(sentence, CHUNK_SIZE)) {
        chunks.push(piece);
      }
      continue;
    }

    const tentative = current ? `${current} ${sentence}` : sentence;
    if (tentative.length > CHUNK_SIZE && current) {
      pushCurrent();
      current = sentence;
    } else {
      current = tentative;
    }
  }

  pushCurrent();
  return chunks;
}

function splitLongText(text, size) {
  const pieces = [];
  let cursor = 0;

  while (cursor < text.length) {
    let end = Math.min(cursor + size, text.length);
    if (end < text.length) {
      const breakPoint = text.lastIndexOf(' ', end);
      if (breakPoint > cursor) {
        end = breakPoint;
      }
    }

    let chunk = text.slice(cursor, end).trim();
    if (!chunk && end === text.length) {
      break;
    }
    if (!chunk) {
      cursor = end + 1;
      continue;
    }

    pieces.push(chunk);
    cursor = end;
    while (cursor < text.length && text[cursor] === ' ') {
      cursor += 1;
    }
  }

  return pieces;
}

function buildSsmlPayload(text = '', rate = DEFAULT_SPEECH_RATE) {
  const normalizedRate = SPEECH_RATE_LOOKUP[normalizeSpeechRate(rate)];
  const safeText = escapeForSsml(text);
  return `<speak><prosody rate="${normalizedRate}">${safeText}</prosody></speak>`;
}

function normalizeSpeechRate(rate) {
  const key = typeof rate === 'string' ? rate.trim() : String(rate || DEFAULT_SPEECH_RATE);
  return SPEECH_RATE_LOOKUP[key] ? key : DEFAULT_SPEECH_RATE;
}

function escapeForSsml(input = '') {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\s+/g, ' ')
    .trim();
}

function prefixChunk(_index, _title = '', _url = '', text = '') {
  return text;
}

function selectVoiceForText(preferredVoice, text) {
  if (containsChinese(text)) {
    return { voiceId: CHINESE_VOICE, languageCode: CHINESE_LANGUAGE_CODE };
  }
  if (preferredVoice === CHINESE_VOICE) {
    return { voiceId: CHINESE_VOICE, languageCode: CHINESE_LANGUAGE_CODE };
  }
  return { voiceId: preferredVoice, languageCode: undefined };
}

function containsChinese(text = '') {
  return /[\u3400-\u9FFF\uF900-\uFAFF]/.test(text);
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, sub);
  }

  return btoa(binary);
}

async function signAwsRequest({ method, url, region, accessKeyId, secretAccessKey, payload }) {
  const parsed = new URL(url);
  const host = parsed.host;
  const pathname = parsed.pathname || '/';
  const canonicalQuery = buildCanonicalQueryString(parsed.searchParams);
  const now = new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(payload);
  const canonicalHeaders =
    `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    method,
    pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');
  const credentialScope = `${dateStamp}/${region}/${AWS_SERVICE}/aws4_request`;
  const stringToSign = [
    AWS_ALGORITHM,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest)
  ].join('\n');

  const signingKey = await getSignatureKey(secretAccessKey, dateStamp, region, AWS_SERVICE);
  const signature = await hmacHex(signingKey, stringToSign);
  const authorization = `${AWS_ALGORITHM} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      'X-Amz-Date': amzDate,
      'X-Amz-Content-Sha256': payloadHash
    }
  };
}

function buildCanonicalQueryString(searchParams) {
  if (!searchParams || Array.from(searchParams).length === 0) {
    return '';
  }

  const pairs = [];
  for (const [key, value] of searchParams.entries()) {
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  pairs.sort();
  return pairs.join('&');
}

function formatAmzDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function sha256Hex(message) {
  const data =
    typeof message === 'string' ? textEncoder.encode(message) : normalizeToArrayBuffer(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return arrayBufferToHex(hashBuffer);
}

async function hmacHex(key, message) {
  const raw = await hmacSha256(key, message);
  return arrayBufferToHex(raw);
}

async function hmacSha256(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    normalizeToArrayBuffer(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, normalizeToArrayBuffer(message));
  return new Uint8Array(signature);
}

async function getSignatureKey(secretAccessKey, dateStamp, region, service) {
  const kSecret = textEncoder.encode(`AWS4${secretAccessKey}`);
  const kDate = await hmacSha256(kSecret, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

function normalizeToArrayBuffer(input) {
  if (typeof input === 'string') {
    return textEncoder.encode(input).buffer;
  }
  if (input instanceof Uint8Array) {
    return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  }
  if (input instanceof ArrayBuffer) {
    return input;
  }
  throw new TypeError('Unsupported data type for crypto operation');
}

function arrayBufferToHex(bufferSource) {
  const bytes =
    bufferSource instanceof Uint8Array ? bufferSource : new Uint8Array(bufferSource || new ArrayBuffer(0));
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

async function getSettings() {
  const { awsAccessKeyId, awsSecretAccessKey, awsRegion, preferredVoice, speechRate } =
    await chrome.storage.local.get([
      'awsAccessKeyId',
      'awsSecretAccessKey',
      'awsRegion',
      'preferredVoice',
      'speechRate'
    ]);
  return {
    accessKeyId: (awsAccessKeyId || '').trim(),
    secretAccessKey: (awsSecretAccessKey || '').trim(),
    region: (awsRegion || DEFAULT_REGION).trim() || DEFAULT_REGION,
    voice: preferredVoice || DEFAULT_VOICE,
    speechRate: normalizeSpeechRate(speechRate)
  };
}

function notifyTab(tabId, payload) {
  chrome.tabs.sendMessage(tabId, payload, () => {
    if (chrome.runtime.lastError) {
      console.debug('Unable to notify tab', chrome.runtime.lastError.message);
    }
  });
}
