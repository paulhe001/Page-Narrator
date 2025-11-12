(() => {
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

  container.appendChild(button);
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
      text
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
    if (text.length > 12000) {
      text = text.slice(0, 12000);
    }
    return text;
  }

  function extractReadableText() {
    const root = findNarrationRoot();
    if (!root) {
      return '';
    }

    const blacklist = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'CANVAS']);
    const skipAncestors = 'header, nav, aside, footer, [role="banner"], [role="navigation"], [aria-label="breadcrumb"]';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node?.parentElement) {
          return NodeFilter.FILTER_SKIP;
        }
        if (blacklist.has(node.parentElement.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.parentElement.closest(skipAncestors)) {
          return NodeFilter.FILTER_REJECT;
        }
        const text = node.nodeValue.replace(/\s+/g, ' ').trim();
        return text ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    let buffer = '';
    while (walker.nextNode()) {
      buffer += walker.currentNode.nodeValue.trim() + ' ';
      if (buffer.length > 12000) {
        break;
      }
    }
    return buffer.replace(/\s+/g, ' ').trim();
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
      '.post-content'
    ];

    for (const selector of preferredSelectors) {
      const candidate = document.querySelector(selector);
      if (hasReadablePayload(candidate)) {
        return candidate;
      }
    }

    const largestBlock = findLargestTextBlock();
    return largestBlock || document.body || null;
  }

  function hasReadablePayload(element) {
    if (!element) {
      return false;
    }
    const text = element.innerText?.replace(/\s+/g, ' ').trim();
    return !!text && text.length > 200;
  }

  function findLargestTextBlock() {
    const candidates = document.querySelectorAll('article, section, div');
    let best = null;
    let maxLength = 0;
    candidates.forEach((el) => {
      if (el.closest('header, nav, footer, aside')) {
        return;
      }
      const text = el.innerText?.replace(/\s+/g, ' ').trim();
      const len = text?.length || 0;
      if (len > maxLength) {
        maxLength = len;
        best = el;
      }
    });
    return maxLength > 400 ? best : null;
  }
})();
