const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json());

// Store active sessions
const sessions = new Map();

// Optional API key authentication
const API_KEY = process.env.API_KEY;
app.use((req, res, next) => {
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Start verification process
app.post('/start-verification', async (req, res) => {
  const { emailAddress, smsPhone, password, domain } = req.body;
  const sessionId = Date.now().toString();
  
  try {
    // Launch browser with production config
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    
    const page = await browser.newPage();
    
    // Add stealth measures
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });
    
    // Store session
    sessions.set(sessionId, {
      browser,
      page,
      emailAddress,
      status: 'started',
      createdAt: Date.now()
    });
    
    // Navigate to Google sign-in
    await page.goto('https://accounts.google.com/signin', {
      waitUntil: 'networkidle2'
    });
    
    // Enter email
    await page.waitForSelector('input[type="email"]', { visible: true });
    await page.type('input[type="email"]', emailAddress, { delay: 100 });
    await page.click('#identifierNext');
    
    // Wait for password field
    await page.waitForSelector('input[type="password"]', { visible: true, timeout: 10000 });
    await page.type('input[type="password"]', password, { delay: 100 });
    await page.click('#passwordNext');
    
    // Wait for navigation after password
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
    
    // Check current state
    const pageContent = await page.content();
    const pageUrl = page.url();
    
    // Check if we need phone verification
    const needsPhone = pageContent.includes('Verify it') || 
                      pageContent.includes('phone number') ||
                      pageContent.includes('Confirm your recovery phone number');
    
    if (needsPhone) {
      // Look for phone input field
      const phoneInput = await page.$('input[type="tel"]') || 
                        await page.$('input[id*="phoneNumber"]');
      
      if (phoneInput) {
        // Clear any existing value and enter phone
        await phoneInput.click({ clickCount: 3 });
        await phoneInput.type(smsPhone, { delay: 100 });
        
        // Find and click continue/next button
        const nextButton = await page.$('button[jsname="LgbsSe"]') || 
                          await page.$('div[data-mdc-dialog-action="next"]') ||
                          await page.$('button:has-text("Next")');
        
        if (nextButton) {
          await nextButton.click();
        } else {
          await page.keyboard.press('Enter');
        }
        
        // Wait for SMS code input to appear
        await page.waitForSelector('input[type="tel"], input[type="text"], input[id*="idvPin"]', {
          visible: true,
          timeout: 10000
        });
      }
      
      sessions.get(sessionId).status = 'awaiting_code';
      
      res.json({
        sessionId,
        status: 'awaiting_sms_code',
        message: 'Password accepted. SMS sent to phone.'
      });
      
    } else if (pageUrl.includes('myaccount.google.com') || 
               pageContent.includes('Google Account')) {
      // Successfully logged in, no phone verification needed
      await browser.close();
      sessions.delete(sessionId);
      
      res.json({
        status: 'success',
        message: 'Login successful, no phone verification needed'
      });
      
    } else {
      // Unexpected state
      sessions.get(sessionId).status = 'unknown';
      
      res.json({
        sessionId,
        status: 'unknown_state',
        message: 'Logged in but in unexpected state',
        currentUrl: pageUrl
      });
    }
    
  } catch (error) {
    console.error('Error in start-verification:', error);
    
    if (sessions.has(sessionId)) {
      try {
        await sessions.get(sessionId).browser.close();
      } catch (e) {}
      sessions.delete(sessionId);
    }
    
    res.status(500).json({
      status: 'error',
      message: error.message,
      details: error.stack
    });
  }
});

// Submit SMS code
app.post('/submit-code', async (req, res) => {
  const { sessionId, smsCode } = req.body;
  
  if (!sessions.has(sessionId)) {
    return res.status(404).json({
      status: 'error',
      message: 'Session not found or expired'
    });
  }
  
  const session = sessions.get(sessionId);
  
  try {
    const { page, browser } = session;
    
    // Find code input - Google uses different selectors
    const codeInput = await page.$('input[type="tel"]') || 
                     await page.$('input[type="text"]') ||
                     await page.$('input[id*="idvPin"]');
    
    if (!codeInput) {
      throw new Error('SMS code input field not found');
    }
    
    // Clear and enter code
    await codeInput.click({ clickCount: 3 });
    await page.keyboard.type(smsCode, { delay: 100 });
    
    // Submit code
    const submitButton = await page.$('button[jsname="LgbsSe"]') || 
                        await page.$('div[data-mdc-dialog-action="next"]');
    
    if (submitButton) {
      await submitButton.click();
    } else {
      await page.keyboard.press('Enter');
    }
    
    // Wait for result
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
    
    const finalUrl = page.url();
    const finalContent = await page.content();
    
    // Check if verification successful
    const success = finalUrl.includes('myaccount.google.com') ||
                   finalContent.includes('Google Account') ||
                   (!finalContent.includes('Wrong code') && 
                    !finalContent.includes('Try again'));
    
    // Clean up
    await browser.close();
    sessions.delete(sessionId);
    
    if (success) {
      res.json({
        status: 'success',
        message: 'Phone verification completed successfully'
      });
    } else {
      res.json({
        status: 'error',
        message: 'Invalid code or verification failed'
      });
    }
    
  } catch (error) {
    console.error('Error in submit-code:', error);
    
    try {
      await session.browser.close();
    } catch (e) {}
    sessions.delete(sessionId);
    
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Cancel session
app.post('/cancel-session', async (req, res) => {
  const { sessionId } = req.body;
  
  if (sessions.has(sessionId)) {
    try {
      await sessions.get(sessionId).browser.close();
    } catch (e) {}
    sessions.delete(sessionId);
  }
  
  res.json({ status: 'cancelled' });
});

// Get session status
app.get('/session-status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  
  if (!sessions.has(sessionId)) {
    return res.status(404).json({
      status: 'error',
      message: 'Session not found'
    });
  }
  
  const session = sessions.get(sessionId);
  res.json({
    status: session.status,
    emailAddress: session.emailAddress,
    age: Date.now() - session.createdAt
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    activeSessions: sessions.size,
    uptime: process.uptime()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Google Account Verification API',
    endpoints: {
      'POST /start-verification': 'Start verification process',
      'POST /submit-code': 'Submit SMS verification code',
      'POST /cancel-session': 'Cancel active session',
      'GET /session-status/:id': 'Check session status',
      'GET /health': 'Health check'
    }
  });
});

const PORT = process.env.PORT || 3000;
const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT) || 300000; // 5 minutes

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Cleanup hanging sessions
setInterval(async () => {
  for (const [id, session] of sessions.entries()) {
    if (Date.now() - session.createdAt > SESSION_TIMEOUT) {
      console.log(`Cleaning up expired session ${id}`);
      try {
        await session.browser.close();
      } catch (e) {}
      sessions.delete(id);
    }
  }
}, 60000); // Check every minute

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  for (const [id, session] of sessions.entries()) {
    try {
      await session.browser.close();
    } catch (e) {}
  }
  process.exit(0);
});