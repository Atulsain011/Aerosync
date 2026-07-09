const ws = require('ws');

// 1. Establish a temporary host socket to retrieve the active OTP dynamically from the running server
const hostSocket = new ws('ws://localhost:5000/ws');

hostSocket.on('open', () => {
  hostSocket.send(JSON.stringify({
    type: 'join',
    clientId: 'test-host-client-temp',
    username: 'Temp Host Client',
    avatar: 'laptop',
    deviceInfo: { platform: 'Linux', userAgent: 'Node test script' }
  }));
});

hostSocket.on('message', (dataRaw) => {
  const msg = JSON.parse(dataRaw.toString());
  if (msg.type === 'welcome') {
    const activeOTP = msg.activeOTP;
    console.log(`Fetched active server OTP dynamically: ${activeOTP}`);
    hostSocket.close();
    
    // Start the remote client simulation with the correct retrieved OTP
    runRemoteSimulation(activeOTP);
  }
});

function runRemoteSimulation(correctOTP) {
  const socket = new ws('ws://localhost:5000/ws', {
    headers: {
      'x-test-ip': '192.168.1.15' // Simulate a remote IP address (non-localhost)
    }
  });

  let testStep = 0;

  socket.on('open', () => {
    console.log('Connected to WS signaling server as a simulated remote client.');
    
    // Step 1: Send registration without OTP
    console.log('Step 1: Sending registration without OTP...');
    socket.send(JSON.stringify({
      type: 'join',
      clientId: 'test-remote-client-12345',
      username: 'Mobile Phone UI',
      avatar: 'phone',
      deviceInfo: { platform: 'Android', userAgent: 'Chrome Mobile' }
    }));
  });

  socket.on('message', (dataRaw) => {
    const msg = JSON.parse(dataRaw.toString());
    console.log('Received from server:', msg);
    
    if (msg.type === 'auth-required' && testStep === 0) {
      console.log('✅ PASS: Server successfully blocked remote device and asked for OTP authorization.');
      
      // Step 2: Submit a wrong OTP
      testStep = 1;
      console.log('Step 2: Sending wrong OTP code 111111...');
      socket.send(JSON.stringify({
        type: 'join',
        clientId: 'test-remote-client-12345',
        username: 'Mobile Phone UI',
        avatar: 'phone',
        deviceInfo: { platform: 'Android', userAgent: 'Chrome Mobile' },
        otp: '111111'
      }));
    }
    
    else if (msg.type === 'auth-failed' && testStep === 1) {
      console.log('✅ PASS: Server successfully rejected wrong OTP.');
      
      // Step 3: Submit the correct OTP
      testStep = 2;
      console.log(`Step 3: Sending correct OTP code ${correctOTP}...`);
      socket.send(JSON.stringify({
        type: 'join',
        clientId: 'test-remote-client-12345',
        username: 'Mobile Phone UI',
        avatar: 'phone',
        deviceInfo: { platform: 'Android', userAgent: 'Chrome Mobile' },
        otp: correctOTP
      }));
    }
    
    else if (msg.type === 'auth-success' && testStep === 2) {
      console.log('✅ PASS: Server successfully verified the correct OTP and replied with auth-success.');
    }
    
    else if (msg.type === 'welcome' && testStep === 2) {
      console.log('✅ PASS: Remote client is now fully authorized and received the welcome mesh list!');
      console.log('All remote client authorization tests have successfully passed!');
      socket.close();
      process.exit(0);
    }
    
    else {
      console.error('❌ FAIL: Unexpected message type or sequence:', msg);
      socket.close();
      process.exit(1);
    }
  });
}
