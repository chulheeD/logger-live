// ✅ Azure OpenAI API 기반 로그 분석 코드 업데이트
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import ModelClient from "@azure-rest/ai-inference";
import { AzureKeyCredential } from "@azure/core-auth";
import fs from "fs";
import puppeteer from "puppeteer";

const endpoint = "https://ai-chdoo12179135ai766061001285.openai.azure.com";
const deployment = "gpt-4o"; // 따로 변수로 설정

const apiKey = "5dWM3YAzhpzJkmJ0RylaW5y3mLfyGTuSaGI2gK93rBBJ8FsLbJF0JQQJ99BDACHYHv6XJ3w3AAAAACOG0BsE"; // 실제 키로 교체됨

const logCollector = [];

function saveLogs() {
  const filename = `console-log-${Date.now()}.json`;
  fs.writeFileSync(filename, JSON.stringify(logCollector, null, 2));
  console.log(`📁 로그 저장 완료: ${filename}`);
  return filename;
}

async function analyzeWithAzureAI(logJsonPath) {
  try {
    const client = new ModelClient(endpoint, new AzureKeyCredential(apiKey));

    const logContent = JSON.parse(fs.readFileSync(logJsonPath, "utf-8"));
    const response = await client.path("/openai/deployments/{deployment}/chat/completions", "gpt-4o").post({
      body: {
        messages: [
          {
            role: "system",
            content: "아래는 더현대닷컴 자동화 테스트 중 발생한 콘솔 로그입니다. 오류를 요약하고 원인 및 대응 방안을 제시해 주세요."
          },
          {
            role: "user",
            content: JSON.stringify(logContent, null, 2)
          }
        ],
        model: "gpt-4o",
        temperature: 0.7,
        max_tokens: 2048
      }
    });

    if (response.status !== "200") {
      throw new Error(JSON.stringify(response.body.error));
    }

    const result = response.body.choices[0].message.content;
    fs.writeFileSync("analysis-result.json", result);
    console.log("📊 분석 결과 저장 완료: analysis-result.json");
  } catch (err) {
    console.error("❌ Azure AI 분석 요청 실패:", err.message);
  }
}

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    args: ["--start-maximized"],
    defaultViewport: { width: 1280, height: 1024 },
  });
  const page = (await browser.pages())[0];

  page.on("console", (msg) => {
    const logType = msg.type(); // 'log', 'warning', 'error', 등
    const message = msg.text().toLowerCase(); // 소문자로 변환해서 비교
  
    if (
      logType === "error" ||
      (logType === "warning" && message.includes("deprecated"))
    ) {
      logCollector.push({
        type: `console-${logType}`,
        message: msg.text(),
        timestamp: new Date().toISOString(),
        url: page.url(),
      });
    }
  });
  
  page.on("pageerror", (err) =>
    logCollector.push({
      type: "pageerror",
      message: err.message,
      timestamp: new Date().toISOString(),
      url: page.url(),
    })
  );
  
  page.on("requestfailed", (req) => {
    try {
      const failedUrl = req.url();
      const hostname = new URL(failedUrl).hostname;
      const excludedDomains = ["analytics.google.com", "www.google-analytics.com"];
  
      if (!excludedDomains.includes(hostname)) {
        logCollector.push({
          type: "request-failed",
          message: req.failure().errorText,
          url: failedUrl,
          timestamp: new Date().toISOString(),
          pageUrl: page.url(),
        });
      }
    } catch (e) {
      // URL 파싱 실패시에도 안전하게 로그 수집 (optional fallback)
      logCollector.push({
        type: "request-failed",
        message: req.failure().errorText,
        url: req.url(),
        timestamp: new Date().toISOString(),
        pageUrl: page.url(),
        note: "⚠️ URL 파싱 실패, 필터 예외 처리됨",
      });
    }
  });

  try {
    await page.goto("https://thehyundai.com/front/dpa/cosHome.thd", { waitUntil: "domcontentloaded" });

    await page.waitForSelector("a.font_small_s_semibold[href*='cosItemList.thd?sectId=']");
    const clothingCategoryUrl = await page.$$eval("a.font_small_s_semibold[href*='cosItemList.thd?sectId=']", (els) => {
      const hrefs = els.map((el) => el.href.startsWith("http") ? el.href : `https://www.thehyundai.com${el.getAttribute("href")}`);
      return hrefs[Math.floor(Math.random() * hrefs.length)];
    });
    await page.goto(clothingCategoryUrl, { waitUntil: "domcontentloaded" });

    let productUrl;
    const hasIframe = await page.$("iframe#sisFrame");

    if (hasIframe) {
      const frameHandle = await page.$("iframe#sisFrame");
      const frame = await frameHandle.contentFrame();
      await frame.waitForSelector(".o-product a");
      const productLinks = await frame.$$eval(".o-product a", (els) => els.map((el) => el.href));
      productUrl = productLinks[Math.floor(Math.random() * productLinks.length)];
    } else {
      await page.waitForSelector(".o-product a");
      const productLinks = await page.$$eval(".o-product a", (els) => els.map((el) => el.href));
      productUrl = productLinks[Math.floor(Math.random() * productLinks.length)];
    }

    productUrl = productUrl.replace("/sis/", "/front/");
    await page.goto(productUrl, { waitUntil: "domcontentloaded" });

    const hasSize = await page.$(".a-size-swatch .size-options.pdp.in-stock") || await page.$(".a-size-swatch .size-options.pdp.free-size");
    if (!hasSize) throw new Error("사이즈 선택 요소를 찾을 수 없습니다.");

    const sizeOptions = await page.$$eval(".a-size-swatch .size-options.pdp", (elements) => {
      return elements.map((el) => ({
        slitmCd: el.getAttribute("slitm-cd"),
        uitmCd: el.getAttribute("uitm-cd"),
        label: el.innerText.trim(),
      }));
    });

    if (sizeOptions.length > 0) {
      const randomSize = sizeOptions[Math.floor(Math.random() * sizeOptions.length)];
      await page.evaluate((label) => {
        const all = Array.from(document.querySelectorAll(".a-size-swatch .size-options.pdp span"));
        const target = all.find(el => el.innerText.trim() === label);
        if (target) target.click();
      }, randomSize.label);
    }

    await page.waitForSelector("#addBagBtn:not([outofstock='true'])");
    await page.click("#addBagBtn");

    await page.waitForSelector("#nav-bag-desktop");
    await page.click("#nav-bag-desktop");

    await page.waitForSelector(".btn-wrap a.btn");
    await page.click(".btn-wrap a.btn");

    // 로그인 팝업 제어
    const pagesAfterPopup = await browser.pages();
    const loginPage = pagesAfterPopup.find(p => p !== page);
    if (!loginPage) throw new Error("로그인 팝업을 찾을 수 없습니다.");
    await loginPage.bringToFront();

    await loginPage.waitForSelector("#btn-go-thdLogin", { visible: true });
    await loginPage.evaluate(() => document.getElementById("btn-go-thdLogin").click());
    await loginPage.type("input[name='id']", "1234@gmail.com");
    await loginPage.type("input[name='pwd']", "1234");
    await loginPage.evaluate(() => memberLogin());


    await new Promise(r => setTimeout(r, 5000));  // 로그인 대기

    await page.bringToFront(); // 기존 주문 페이지로 복귀
    await page.reload({ waitUntil: "domcontentloaded" });  // 로그인 상태 반영

    await page.waitForSelector("#restPayRadio", { visible: true, timeout: 10000 });
    await page.evaluate(() => {
      document.querySelector("#restPayRadio").scrollIntoView({ behavior: "instant", block: "center" });
    });


   



    await page.click("#restPayRadio");

    // 무통장입금 선택이 이미 되어 있다면 클릭 생략
    const isCashChecked = await page.$eval("input[name='pay-depth1'][value='cash']", el => el.checked);
    if (!isCashChecked) {
      await page.click("input[name='pay-depth1'][value='cash']");
    }

    await page.waitForSelector("#ordAgreeChk");
    await page.click("#ordAgreeChk");

    await Promise.all([
      page.waitForNavigation({ timeout: 60000, waitUntil: "networkidle2" }),
      page.evaluate(() => {
        const orderBtn = document.querySelector("a.btn.color2.size7");
        if (orderBtn) orderBtn.click();  // onclick="order(this)" 트리거됨
      }),
    ]);
    
    // 주문 내역 페이지로 이동
    await page.goto("https://www.thehyundai.com/front/mpa/selectOrdDlvCrst.thd", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("a.btn.size1.color7");
    const cancelUrls = await page.$$eval("a.btn.size1.color7", els => els.map(el => el.href));
    const latestCancelUrl = cancelUrls[0];

    await page.goto(latestCancelUrl, { waitUntil: "domcontentloaded" });

    // 수량 저장 클릭
    await page.waitForFunction(() => typeof fnOrdCnclQtyChg === 'function');
    await page.evaluate(() => fnOrdCnclQtyChg());

    // 단순변심 선택
    await page.select("select[name='cnslInqr']", "010105");

    // 주문취소 버튼 클릭 전 팝업 처리기 등록
    page.on("dialog", async (dialog) => {
      console.log("📌 알림 팝업 확인:", dialog.message());
      await dialog.accept();
    });

    // 주문취소 버튼 클릭
    await page.click("#btnOrdCnclReq");

    // 로그아웃 수행
    //await page.goto("https://www.thehyundai.com/front/member/logout.thd", { waitUntil: "domcontentloaded" });


    const savedLog = saveLogs();
    await analyzeWithAzureAI(savedLog);
  } catch (err) {
    console.error("❌ 테스트 도중 오류 발생:", err.message);
    const savedLog = saveLogs();
    await analyzeWithAzureAI(savedLog);
  }

  await browser.close();
})();


