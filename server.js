// Updated start-verification endpoint with better error handling

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

// Add a test endpoint to check if login works
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
