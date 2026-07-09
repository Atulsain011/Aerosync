const ws = require('ws');
const http = require('http');
const fs = require('fs');

// Fetch CDP list to get WebSocket URL
http.get('http://127.0.0.1:9222/json/list', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const list = JSON.parse(data);
      const pageTarget = list.find(t => t.type === 'page');
      
      if (!pageTarget) {
        console.error('No page tab found. Available targets:', list);
        process.exit(1);
      }
      
      const webSocketDebuggerUrl = pageTarget.webSocketDebuggerUrl;
      console.log('Connecting to Page Tab URL:', pageTarget.url);
      
      const client = new ws(webSocketDebuggerUrl);
      client.on('open', () => {
        console.log('CDP Connection opened. Enabling domains...');
        client.send(JSON.stringify({ id: 1, method: 'Console.enable' }));
        client.send(JSON.stringify({ id: 2, method: 'Runtime.enable' }));
        client.send(JSON.stringify({ id: 3, method: 'Page.enable' }));
        
        // Navigate manually
        console.log('Navigating to http://localhost:5000...');
        client.send(JSON.stringify({
          id: 4,
          method: 'Page.navigate',
          params: { url: 'http://localhost:5000' }
        }));
      });
      
      client.on('message', (dataRaw) => {
        const msg = JSON.parse(dataRaw.toString());
        
        if (msg.method === 'Runtime.consoleAPICalled') {
          console.log('[BROWSER CONSOLE]', msg.params.args.map(a => a.value || a.description || JSON.stringify(a)).join(' '));
        }
        if (msg.method === 'Runtime.exceptionThrown') {
          console.error('[BROWSER EXCEPTION]', msg.params.exceptionDetails.exception.description);
        }
        
        // Check for load event
        if (msg.method === 'Page.loadEventFired') {
          console.log('Page loaded! Evaluating layout in 1.5 seconds...');
          setTimeout(() => {
            client.send(JSON.stringify({
              id: 50,
              method: 'Runtime.evaluate',
              params: {
                expression: `(() => {
                  const otpBanner = document.getElementById('radar-otp-banner');
                  const otpCode = document.getElementById('radar-otp-code');
                  const pendingSection = document.getElementById('host-pending-section');
                  const overlay = document.getElementById('auth-overlay');
                  
                  return {
                    otpBannerStyle: otpBanner ? window.getComputedStyle(otpBanner).display : 'Not found',
                    otpValue: otpCode ? otpCode.textContent : 'Not found',
                    pendingSectionStyle: pendingSection ? window.getComputedStyle(pendingSection).display : 'Not found',
                    isOverlayHidden: overlay ? (overlay.style.display === 'none') : 'Not found'
                  };
                })()`,
                returnByValue: true
              }
            }));
          }, 1500);
        }
        
        if (msg.id === 50) {
          console.log('\n--- Host Authorization Diagnostics ---');
          console.log(msg.result.result.value);
          
          // Capture screenshot
          client.send(JSON.stringify({
            id: 51,
            method: 'Page.captureScreenshot',
            params: { format: 'png' }
          }));
        }
        
        if (msg.id === 51) {
          const base64Data = msg.result.data;
          fs.writeFileSync('/home/atul/Desktop/updated ui/host-dashboard.png', Buffer.from(base64Data, 'base64'));
          console.log('Host dashboard screenshot saved to /home/atul/Desktop/updated ui/host-dashboard.png');
          client.close();
          process.exit(0);
        }
      });
    } catch (e) {
      console.error('CDP parse error:', e);
      process.exit(1);
    }
  });
}).on('error', (err) => {
  console.error('Error contacting CDP port:', err.message);
  process.exit(1);
});
