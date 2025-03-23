const fs = require("fs").promises;
const axios = require("axios");
const chalk = require("chalk");
const { SocksProxyAgent } = require("socks-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { jwtDecode } = require("jwt-decode");

const TOKEN_FILE = "tokens.txt";
const PROXY_FILE = "proxies.txt";
const CLAIM_ENDPOINT = "https://api.sogni.ai/v2/account/reward/claim";
const REWARD_ENDPOINT = "https://api.sogni.ai/v2/account/rewards";
const REFRESH_TOKEN = "https://api.sogni.ai/v1/account/refresh-token";
const DAILY_BOOST_ID = "2";
const CHECK_INTERVAL_MINUTES = 60;
const CHECK_INTERVAL_MS = CHECK_INTERVAL_MINUTES * 60 * 1000;

function printBanner() {
  const purple = chalk.rgb(109, 4, 221);
  console.log(purple("TOOL ĐƯỢC PHÁT TRIỂN BỞI: THIEN THO TRAN"));
  console.log(
    purple(
      "Tham gia group facebook để nhận tool mới: https://www.facebook.com/groups/2072702003172443/"
    )
  );
  console.log(
    purple(
      "Tham gia group Telegram để chia sẻ kiến thức tại: https://web.telegram.org/k/#@mmoFromAirdrop"
    )
  );
  console.log(
    purple("------------------------------------------------------------")
  );
}

async function loadAccounts() {
  try {
    const token = await fs.readFile(TOKEN_FILE, "utf8");
    return token
      .trim()
      .split("\n")
      .map((acc) => acc.trim())
      .filter((acc) => acc);
  } catch (error) {
    console.error(chalk.red("Lỗi đọc file tokens:", error.message));
    process.exit(1);
  }
}

async function loadProxies() {
  try {
    const data = await fs.readFile(PROXY_FILE, "utf8");
    const proxyList = data
      .trim()
      .split("\n")
      .map((proxy) => proxy.trim())
      .filter((proxy) => proxy);
    console.log(
      chalk.green(`Đã load được ${proxyList.length} proxies từ ${PROXY_FILE}`)
    );
    return proxyList;
  } catch (error) {
    console.warn(
      chalk.yellow("không có proxies nào được tìm thấy:", error.message)
    );
    return [];
  }
}

function createProxyAgent(proxyUrl) {
  try {
    if (!proxyUrl) return null;
    const url = proxyUrl.toLowerCase();
    if (url.startsWith("socks4://") || url.startsWith("socks5://")) {
      return new SocksProxyAgent(proxyUrl);
    } else if (url.startsWith("http://") || url.startsWith("https://")) {
      return new HttpsProxyAgent(proxyUrl);
    } else {
      return new HttpsProxyAgent(`http://${proxyUrl}`);
    }
  } catch (error) {
    console.error(
      chalk.red(`Lỗi tạo agent-proxy ${proxyUrl}: ${error.message}`)
    );
    return null;
  }
}

function createAxiosInstance(proxyUrl = null) {
  const config = {
    headers: {
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
    },
    timeout: 30000,
    maxRedirects: 5,
  };

  let proxyAgent = null;
  if (proxyUrl) {
    proxyAgent = createProxyAgent(proxyUrl);
    if (proxyAgent) {
      config.httpsAgent = proxyAgent;
      config.httpAgent = proxyAgent;
      console.log(
        chalk.green(
          `[${new Date().toISOString()}] Đã tạo thành công agent-proxy cho proxy ${proxyUrl}`
        )
      );
    } else {
      console.warn(
        chalk.yellow(
          `[${new Date().toISOString()}] Lỗi tạo agent-proxy ${proxyUrl}, Sử dụng mạng trực tiếp.`
        )
      );
    }
  } else {
    console.log(
      chalk.yellow(
        `[${new Date().toISOString()}] Không có proxy nào được cung cấp, sử dụng mạng trực tiếp`
      )
    );
  }

  const instance = axios.create(config);

  instance.interceptors.response.use(
    (response) => response,
    async (error) => {
      const config = error.config;
      if (!config || config._retryCount >= (config.maxRetries || 3)) {
        return Promise.reject(error);
      }
      config._retryCount = (config._retryCount || 0) + 1;
      const delay = 1000 * Math.pow(2, config._retryCount - 1);
      console.log(
        chalk.yellow(
          `Thử lại request (${config._retryCount}/3) sau ${delay}ms...`
        )
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      return instance(config);
    }
  );

  return instance;
}

async function checkRewardStatus(token, axiosInstance) {
  try {
    const response = await axiosInstance.get(REWARD_ENDPOINT, {
      headers: { authorization: token, Referer: "https://app.sogni.ai/" },
    });
    if (response.data.status === "success") {
      const dailyBoost = response.data.data.rewards.find(
        (r) => r.id === DAILY_BOOST_ID
      );
      if (dailyBoost?.canClaim === 1) return true;
      if (dailyBoost?.lastClaimTimestamp && dailyBoost.claimResetFrequencySec) {
        const nextAvailable =
          (dailyBoost.lastClaimTimestamp + dailyBoost.claimResetFrequencySec) *
          1000;
        const timeLeft = nextAvailable - Date.now();
        if (timeLeft > 0) {
          const hours = Math.floor(timeLeft / (3600 * 1000));
          const minutes = Math.floor((timeLeft % (3600 * 1000)) / (60 * 1000));
          console.log(
            chalk.yellow(
              `[${new Date().toISOString()}] Next claim in ${hours}h ${minutes}m`
            )
          );
        }
      }
    }
    return false;
  } catch (error) {
    console.error(
      chalk.red(
        `[${new Date().toISOString()}] Lỗi check reward: ${error.message}`
      )
    );
    if (error.response) {
      console.error(
        chalk.red(
          `Trạng thái: ${error.response.status}, Dữ liệu: ${JSON.stringify(
            error.response.data
          )}`
        )
      );
    }
    return false;
  }
}

async function claimDailyBoost(token, axiosInstance) {
  try {
    const response = await axiosInstance.post(
      CLAIM_ENDPOINT,
      { claims: [DAILY_BOOST_ID] },
      {
        headers: { authorization: token, Referer: "https://app.sogni.ai/" },
      }
    );
    if (response.data.status === "success") {
      console.log(
        chalk.green(
          `[${new Date().toISOString()}] Nhận điểm daily thành công!`
        )
      );
      return true;
    }
    console.error(
      chalk.yellow(
        `[${new Date().toISOString()}] Lỗi nhận daily: ${
          response.data.message || "Unknown error"
        }`
      )
    );
    return false;
  } catch (error) {
    console.error(
      chalk.red(
        `[${new Date().toISOString()}] Lỗi claiming boost: ${error.message}`
      )
    );
    if (error.response)
      console.error(
        chalk.red(
          `Trạng thái: ${error.response.status}, Dữ liệu: ${JSON.stringify(
            error.response.data
          )}`
        )
      );
    return false;
  }
}

async function refreshNewToken(refreshToken, axiosInstance) {
  const response = await axiosInstance.post(
    REFRESH_TOKEN,
    {
      refreshToken: refreshToken,
    },
    {
      headers: { Referer: "https://app.sogni.ai/" },
    }
  );

  if (response.status == 200) {
    return {
      refresh: response.data.data.refreshToken,
      token: response.data.data.token,
    };
  }
  return {
    refresh: null,
    token: null,
  };
}

async function checkAndClaim(account, axiosInstance) {
  try {
    let [tokenAccess, refreshToken] = account
      .split(",")
      .map((data) => data.trim());
    const decoded = jwtDecode(tokenAccess);
    if (decoded.exp * 1000 <= new Date().getTime()) {
      console.log(chalk.red(`\ntoken đã hết hạn, cần lấy token mới`));
      const { token, refresh } = await refreshNewToken(
        refreshToken,
        axiosInstance
      );
      if (!token) {
        console.log(chalk.red(`\nCó lỗi khi refresh token`));
        return;
      }
      const tokenLines = (await fs.readFile(TOKEN_FILE, "utf-8")).split("\n");
      const accountIndex = tokenLines.findIndex(
        (acc) => acc.split(",")[0].trim() === tokenAccess
      );
      tokenLines[accountIndex] = `${token},${refresh}`;
      await fs.writeFile(TOKEN_FILE, tokenLines.join("\n"), "utf-8");
      console.log(
        chalk.green(
          `Tài khoản ${accountIndex + 1} đã được refresh token thành công`
        )
      );
      tokenAccess = token;
    }
    const isClaimable = await checkRewardStatus(tokenAccess, axiosInstance);
    if (isClaimable) {
      await claimDailyBoost(tokenAccess, axiosInstance);
    } else {
      console.log(
        chalk.yellow(`[${new Date().toISOString()}] Đã claim rồi, đợi ngày hôm sau.`)
      );
    }
  } catch (error) {
    console.error(
      chalk.red(
        `[${new Date().toISOString()}] Lỗi trong tiến trình: ${error.message}`
      )
    );
  }
  setTimeout(
    () => checkAndClaim(tokenAccess, axiosInstance),
    CHECK_INTERVAL_MS
  );
}

async function main() {
  printBanner();
  console.log(
    chalk.green(
      `[${new Date().toISOString()}] Bắt đầu daily claim...`
    )
  );
  console.log(
    chalk.green(
      `[${new Date().toISOString()}] Sẽ tiếp tục checkin trong ${CHECK_INTERVAL_MINUTES} phút.`
    )
  );

  const [accounts, proxies] = await Promise.all([
    loadAccounts(),
    loadProxies(),
  ]);
  if (!accounts.length) throw new Error("Không tìm thấy tokens trong file token.txt");

  console.log(chalk.green(`📝 Load ${accounts.length} tài khoản`));
  if (proxies.length) {
    console.log(chalk.green(`🌐 Loaded ${proxies.length} proxies`));
  } else {
    console.log(chalk.yellow(`🌐 Không có proxy, Chạy mạng trực tiếp`));
  }

  accounts.forEach((account, index) => {
    const proxy = proxies[index % proxies.length] || null;
    const axiosInstance = createAxiosInstance(proxy);
    checkAndClaim(account, axiosInstance);
  });
}

main().catch((error) => {
  console.error(chalk.red("❌  Lỗi:", error.message));
  setTimeout(main, 60000); // Restart after 1 minute
});
