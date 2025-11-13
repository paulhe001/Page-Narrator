(() => {
  const TEXT_LIMIT = 12000;
  const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre';
  const NON_CONTENT_CONTAINERS =
    'header, nav, aside, footer, form, menu, [role="banner"], [role="navigation"], [role="contentinfo"], [aria-label="breadcrumb"], [aria-label*="breadcrumb" i]';
  const SKIP_CLASS_KEYWORDS = ['breadcrumb', 'subscribe', 'related', 'promo', 'share', 'social', 'footer'];
  const CONTENT_KEYWORDS = ['article', 'body', 'story', 'content', 'main', 'post', 'entry', 'rich-text'];
  const MIN_BLOCK_CHARS = 35;
  const DEFAULT_SPEECH_RATE = '1';

  if (window.__chatgptTtsInjected__) {
    return;
  }
  window.__chatgptTtsInjected__ = true;

  const state = {
    isNarrating: false,
    queue: [],
    currentAudio: null,
    chunkCounter: 0
  };

  const container = document.createElement('div');
  container.id = 'chatgpt-tts-container';

  const button = document.createElement('button');
  button.id = 'chatgpt-tts-play';
  button.type = 'button';
  button.textContent = '▶ Read page';

  const status = document.createElement('div');
  status.id = 'chatgpt-tts-status';
  status.textContent = 'Idle';

  const controls = document.createElement('div');
  controls.id = 'chatgpt-tts-controls';
  const speedControl = createSpeedControl();

  controls.appendChild(button);
  controls.appendChild(speedControl);

  container.appendChild(controls);
  container.appendChild(status);
  document.documentElement.appendChild(container);

  button.addEventListener('click', () => {
    if (state.isNarrating) {
      chrome.runtime.sendMessage({ type: 'stopNarration' });
      resetPlayback('Stopped');
      return;
    }

    const text = extractSelectionText() || extractReadableText();
    if (!text) {
      setStatus('Nothing to read on this page.');
      return;
    }

    state.queue.length = 0;
    disposeAudio();
    chrome.runtime.sendMessage({
      type: 'startNarration',
      title: document.title,
      url: location.href,
      text,
      speechRate: getSelectedSpeechRate()
    });
    state.isNarrating = true;
    state.chunkCounter = 0;
    button.textContent = '■ Stop';
    setStatus('Request sent...');
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) {
      return;
    }

    if (message.type === 'tts-status') {
      setStatus(message.status || 'Working...');
      return;
    }

    if (message.type === 'tts-error') {
      setStatus(message.error || 'Something went wrong');
      resetPlayback('Error');
      return;
    }

    if (message.type === 'tts-audio-chunk') {
      enqueueChunk(message);
      return;
    }

    if (message.type === 'tts-complete') {
      setStatus('Playback complete');
      state.isNarrating = false;
      button.textContent = '▶ Read again';
      return;
    }
  });

  function enqueueChunk({ base64Audio, format }) {
    if (!base64Audio) {
      return;
    }

    const src = `data:audio/${format || 'mp3'};base64,${base64Audio}`;
    state.queue.push(src);
    playNext();
  }

  function playNext() {
    if (state.currentAudio || state.queue.length === 0) {
      return;
    }

    const nextSrc = state.queue.shift();
    const audio = new Audio(nextSrc);
    state.currentAudio = audio;
    setStatus(`Playing chunk ${++state.chunkCounter}`);
    audio.addEventListener('ended', () => {
      state.currentAudio = null;
      playNext();
    });
    audio.addEventListener('error', () => {
      setStatus('Audio playback error');
      state.currentAudio = null;
      playNext();
    });
    audio.play().catch((error) => {
      console.error('Audio play failed', error);
      setStatus('Unable to play audio. Check autoplay permissions.');
      state.currentAudio = null;
    });
  }

  function setStatus(text) {
    status.textContent = text;
  }

  function resetPlayback(msg) {
    state.isNarrating = false;
    button.textContent = '▶ Read page';
    setStatus(msg || 'Idle');
    state.queue.length = 0;
    disposeAudio();
  }

  function disposeAudio() {
    if (state.currentAudio) {
      try {
        state.currentAudio.pause();
      } catch (error) {
        // ignore
      }
      state.currentAudio = null;
    }
  }

  function extractSelectionText() {
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed) {
      return '';
    }
    let text = selection.toString().replace(/\s+/g, ' ').trim();
    if (!text) {
      return '';
    }
    if (text.length > TEXT_LIMIT) {
      text = text.slice(0, TEXT_LIMIT);
    }
    return text;
  }

  function extractReadableText() {
    const root = findNarrationRoot();
    if (!root) {
      return '';
    }

    const blocks = gatherReadableBlocks(root);
    if (blocks.length > 0) {
      const joined = blocks.join('\n\n').trim();
      return joined.length > TEXT_LIMIT ? joined.slice(0, TEXT_LIMIT) : joined;
    }

    return legacyCollectText(root);
  }

  function findNarrationRoot() {
    const preferredSelectors = [
      'main',
      'article',
      '[role="main"]',
      '#main',
      '#content',
      '.main-content',
      '.article-content',
      '.post-content',
      '[data-testid="Body"]',
      '[data-testid="article-body"]',
      '.ArticleBody-body'
    ];

    for (const selector of preferredSelectors) {
      const candidate = document.querySelector(selector);
      if (candidate && getNormalizedLength(candidate) > 400) {
        return candidate;
      }
    }

    let best = null;
    let bestScore = 0;
    const candidates = document.querySelectorAll('article, section, div, main');
    candidates.forEach((el) => {
      if (!el || el.matches(NON_CONTENT_CONTAINERS) || el.closest(NON_CONTENT_CONTAINERS)) {
        return;
      }
      const score = scoreCandidate(el);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    });
    return best || document.body || null;
  }

  function gatherReadableBlocks(root) {
    const blocks = [];
    let total = 0;
    const elements = root.querySelectorAll(BLOCK_SELECTOR);
    for (const el of elements) {
      if (total >= TEXT_LIMIT) {
        break;
      }
      if (shouldSkipElement(el)) {
        continue;
      }
      const text = normalizeText(el.innerText || '');
      if (!isMeaningfulBlock(text)) {
        continue;
      }
      const remaining = TEXT_LIMIT - total;
      const chunk = text.length > remaining ? text.slice(0, remaining) : text;
      blocks.push(chunk);
      total += chunk.length + 1;
    }
    return blocks;
  }

  function legacyCollectText(root) {
    const blacklist = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'CANVAS']);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node?.parentElement) {
          return NodeFilter.FILTER_SKIP;
        }
        if (blacklist.has(node.parentElement.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.parentElement.closest(NON_CONTENT_CONTAINERS)) {
          return NodeFilter.FILTER_REJECT;
        }
        const text = node.nodeValue.replace(/\s+/g, ' ').trim();
        return text ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    let buffer = '';
    while (walker.nextNode()) {
      buffer += walker.currentNode.nodeValue.trim() + ' ';
      if (buffer.length > TEXT_LIMIT) {
        break;
      }
    }
    return buffer.replace(/\s+/g, ' ').trim();
  }

  function normalizeText(text) {
    return text.replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').replace(/[•·]/g, ' ').trim();
  }

  function isMeaningfulBlock(text) {
    if (!text || text.length < MIN_BLOCK_CHARS) {
      return false;
    }
    if (/^(advertisement|sponsored|more from)/i.test(text)) {
      return false;
    }
    const letters = text.replace(/[\s\d.,!?'"-]/g, '');
    return letters.length > 4;
  }

  function shouldSkipElement(element) {
    if (!element || element.matches('figure figcaption, figcaption, caption')) {
      return false;
    }
    if (element.closest(NON_CONTENT_CONTAINERS)) {
      return true;
    }
    if (element.matches('button, input, textarea, select, label')) {
      return true;
    }
    const attr = `${element.className || ''} ${element.id || ''}`.toLowerCase();
    if (SKIP_CLASS_KEYWORDS.some((keyword) => attr.includes(keyword))) {
      return true;
    }
    const ariaLabel = (element.getAttribute?.('aria-label') || '').toLowerCase();
    if (ariaLabel && SKIP_CLASS_KEYWORDS.some((keyword) => ariaLabel.includes(keyword))) {
      return true;
    }
    const dataTestId = (element.dataset?.testid || '').toLowerCase();
    return dataTestId && SKIP_CLASS_KEYWORDS.some((keyword) => dataTestId.includes(keyword));
  }

  function scoreCandidate(element) {
    const length = getNormalizedLength(element);
    if (length < 400) {
      return 0;
    }
    let score = length;
    const tagName = element.tagName.toLowerCase();
    if (tagName === 'article' || tagName === 'main') {
      score += 800;
    } else if (tagName === 'section') {
      score += 200;
    }
    const attr = `${element.className || ''} ${element.id || ''}`.toLowerCase();
    CONTENT_KEYWORDS.forEach((keyword) => {
      if (attr.includes(keyword)) {
        score += 400;
      }
    });
    const dataTestId = (element.dataset?.testid || '').toLowerCase();
    CONTENT_KEYWORDS.forEach((keyword) => {
      if (dataTestId.includes(keyword)) {
        score += 400;
      }
    });
    return score;
  }

  function getNormalizedLength(element) {
    const text = element?.innerText?.replace(/\s+/g, ' ').trim();
    return text?.length || 0;
  }
})();
  function createSpeedControl() {
    const select = document.createElement('select');
    select.id = 'chatgpt-tts-speed';
    select.setAttribute('aria-label', 'Speech speed');

    getSpeechRateOptions().forEach((option) => {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      select.appendChild(opt);
    });
    select.value = 1;

    chrome.storage?.local.get(['speechRate'], (stored = {}) => {
      const options = getSpeechRateOptions();
      const saved = stored.speechRate;
      if (options.some((opt) => opt.value === saved)) {
        select.value = saved;
      } else {
        select.value = DEFAULT_SPEECH_RATE;
      }
    });

    select.addEventListener('change', () => {
      chrome.storage?.local.set({ speechRate: select.value });
    });

    return select;
  }

  function getSelectedSpeechRate() {
    const select = document.getElementById('chatgpt-tts-speed');
    const options = getSpeechRateOptions();
    if (select && options.some((opt) => opt.value === select.value)) {
      return select.value;
    }
    return DEFAULT_SPEECH_RATE;
  }

  function getSpeechRateOptions() {
    return [
      { value: '0.75', label: '0.75×' },
      { value: '1', label: '1×' },
      { value: '1.25', label: '1.25×' }
    ];
  }
