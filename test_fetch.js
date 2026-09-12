const https = require('https');
https.get('https://openrouter.ai/api/v1/models', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      const oModels = parsed.data.filter(m => m.id.includes('o1') || m.id.includes('o3') || m.id.includes('reason'));
      oModels.forEach(m => console.log(JSON.stringify(m, null, 2)));
    } catch(e) {
      console.log('Error parsing', e);
    }
  });
});
