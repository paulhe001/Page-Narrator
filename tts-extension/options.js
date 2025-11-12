document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('settings');
  const accessKeyField = document.getElementById('accessKey');
  const secretKeyField = document.getElementById('secretKey');
  const regionField = document.getElementById('region');
  const voiceField = document.getElementById('voice');
  const flash = document.getElementById('flash');

  chrome.storage.local.get(
    ['awsAccessKeyId', 'awsSecretAccessKey', 'awsRegion', 'preferredVoice'],
    (stored) => {
      if (stored.awsAccessKeyId) {
        accessKeyField.value = stored.awsAccessKeyId;
      }
      if (stored.awsSecretAccessKey) {
        secretKeyField.value = stored.awsSecretAccessKey;
      }
      if (stored.awsRegion) {
        regionField.value = stored.awsRegion;
      }
      if (stored.preferredVoice) {
        voiceField.value = stored.preferredVoice;
      }
    }
  );

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    chrome.storage.local.set(
      {
        awsAccessKeyId: accessKeyField.value.trim(),
        awsSecretAccessKey: secretKeyField.value.trim(),
        awsRegion: regionField.value.trim() || 'us-east-1',
        preferredVoice: voiceField.value
      },
      () => {
        flash.textContent = 'Settings saved';
        flash.style.color = '#047857';
        setTimeout(() => {
          flash.textContent = '';
        }, 2500);
      }
    );
  });
});
