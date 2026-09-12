const https = require('https');
https.get('https://openrouter.ai/api/v1/models', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      const oModels = parsed.data.filter(m => m.id === 'openai/o3-mini');
      oModels.forEach(m => console.log(m.description));
    } catch(e) {
      console.log('Error parsing', e);
    }
  });
});
