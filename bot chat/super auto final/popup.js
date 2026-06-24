// popup.js

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const delayInput = document.getElementById('delay-input');
  
  // Google Sheets elements
  const sheetUrlInput = document.getElementById('sheet-url-input');
  const btnConnectSheet = document.getElementById('btn-connect-sheet');
  const btnCheckSheet = document.getElementById('btn-check-sheet');
  const channelSelectGroup = document.getElementById('channel-select-group');
  const channelSelect = document.getElementById('channel-select');
  const channelMeta = document.getElementById('channel-meta');
  const sheetPreflight = document.getElementById('sheet-preflight');
  const sheetConnectionStatus = document.getElementById('sheet-connection-status');
  const txtFolderInput = document.getElementById('txt-folder-input');
  const btnSaveFolder = document.getElementById('btn-save-folder');
  
  const btnStart = document.getElementById('btn-start');
  const btnTestRun = document.getElementById('btn-test-run');
  const btnPause = document.getElementById('btn-pause');
  const btnStop = document.getElementById('btn-stop');
  const btnClearLogs = document.getElementById('btn-clear-logs');
  
  const statusLabel = document.getElementById('status-label');
  const progressText = document.getElementById('progress-text');
  const progressPercent = document.getElementById('progress-percent');
  const progressBar = document.getElementById('progress-bar');
  const activeJobDetail = document.getElementById('active-job-detail');
  const logScreen = document.getElementById('log-screen');
  const SHEET_REQUEST_TIMEOUT_MS = 25000;
  let sheetRequestSeq = 0;
  let activeSheetAbortController = null;
  let activeSheetStatusTimer = null;
  let sheetRequestInFlight = false;

  // 2. Xử lý Google Sheets Connection
  btnConnectSheet.addEventListener('click', () => {
    connectSheet('connect');
  });

  btnCheckSheet.addEventListener('click', () => {
    connectSheet('check');
  });

  if (btnSaveFolder && txtFolderInput) {
    btnSaveFolder.addEventListener('click', () => {
      const val = txtFolderInput.value.trim();
      chrome.storage.local.set({ txtExportFolderUrl: val }, () => {
        addLocalLog(val ? `Đã cấu hình folder lưu TXT: ${val}` : "Đã xoá cấu hình folder lưu TXT (sử dụng cấu hình trong Sheet/mặc định).", "success");
        alert("Đã lưu cấu hình Folder lưu TXT!");
      });
    });
  }

  function connectSheet(mode) {
    const connection = getConnectionInput();
    const url = connection.url;
    if (!url) {
      alert("Vui lòng nhập URL Google Apps Script Web App.");
      return;
    }

    // Đảm bảo URL kết thúc đúng dạng hoặc cảnh báo nếu sai định dạng cơ bản
    if (!url.startsWith("https://script.google.com/")) {
      alert("URL không đúng định dạng của Google Web App.");
      return;
    }

    chrome.storage.local.get(['webAppUrl', 'webAppToken'], (state) => {
      const storedConnection = splitWebAppUrlAndToken(state.webAppUrl || '');
      const canReuseStoredToken = storedConnection.url === url;
      const token = connection.token || (canReuseStoredToken ? state.webAppToken : '') || '';

      const isCheck = mode === 'check';
      const activeButton = isCheck ? btnCheckSheet : btnConnectSheet;
      const requestId = ++sheetRequestSeq;
      if (activeSheetAbortController) {
        activeSheetAbortController.abort();
      }
      const abortController = new AbortController();
      activeSheetAbortController = abortController;
      let didTimeout = false;
      const startedAt = Date.now();
      const timeoutId = setTimeout(() => {
        didTimeout = true;
        abortController.abort();
      }, SHEET_REQUEST_TIMEOUT_MS);
      sheetConnectionStatus.innerText = isCheck ? "Đang kiểm tra Sheet..." : "Đang kết nối...";
      sheetConnectionStatus.className = "sheet-status-text";
      sheetRequestInFlight = true;
      startSheetStatusTimer(isCheck, startedAt);
      activeButton.disabled = true;
      btnConnectSheet.disabled = true;
      btnCheckSheet.disabled = true;

      sheetUrlInput.value = url;

      fetchWebAppConfig(url, token, abortController.signal)
        .then(config => {
          if (requestId !== sheetRequestSeq) return;
          saveConnectedSheetConfig(url, token, config, () => {
            if (requestId !== sheetRequestSeq) return;
            populateChannels(config.channels || [], null, config.channelStats || []);
            renderSheetPreflight(config);
            sheetConnectionStatus.innerText = isCheck ? "Kiểm tra Sheet xong." : "Kết nối thành công!";
            sheetConnectionStatus.className = "sheet-status-text connected";
            addLocalLog(isCheck ? "Đã kiểm tra Sheet và cập nhật danh sách kênh." : "Đã kết nối thành công với Google Sheets.", "success");
          });
        })
        .catch(err => {
          if (requestId !== sheetRequestSeq) return;
          if (err && err.name === "AbortError" && didTimeout) {
            err = new Error(`Web App phan hoi qua ${Math.round(SHEET_REQUEST_TIMEOUT_MS / 1000)}s. Vui long thu lai.`);
          }
          sheetConnectionStatus.innerText = (isCheck ? "Lỗi kiểm tra Sheet: " : "Lỗi kết nối: ") + err.message;
          sheetConnectionStatus.className = "sheet-status-text error";
          chrome.storage.local.set({ sheetConnected: false });
          addLocalLog((isCheck ? "Kiểm tra Sheet thất bại: " : "Kết nối Google Sheets thất bại: ") + err.message, "system");
        })
        .finally(() => {
          clearTimeout(timeoutId);
          if (requestId === sheetRequestSeq) {
            activeSheetAbortController = null;
            sheetRequestInFlight = false;
            stopSheetStatusTimer();
            btnConnectSheet.disabled = false;
            btnCheckSheet.disabled = false;
          }
        });
    });
  }

  function startSheetStatusTimer(isCheck, startedAt) {
    stopSheetStatusTimer();
    const label = isCheck ? "Dang kiem tra Sheet" : "Dang ket noi";
    const render = () => {
      const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      const maxSeconds = Math.round(SHEET_REQUEST_TIMEOUT_MS / 1000);
      sheetConnectionStatus.innerText = `${label}... ${elapsedSeconds}/${maxSeconds}s`;
    };
    render();
    activeSheetStatusTimer = setInterval(render, 1000);
  }

  function stopSheetStatusTimer() {
    if (activeSheetStatusTimer) {
      clearInterval(activeSheetStatusTimer);
      activeSheetStatusTimer = null;
    }
  }

  function fetchWebAppConfig(url, token, signal) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'getConfig', token: token }),
      signal
    })
      .then(response => {
        if (!response.ok) throw new Error("Không thể kết nối với Web App.");
        return response.json();
      })
      .then(config => {
        if (config.error) throw new Error(config.error);
        return config;
      });
  }

  function saveConnectedSheetConfig(url, token, config, callback) {
    chrome.storage.local.set({
      webAppUrl: url,
      webAppToken: token,
      promptND: config.promptND,
      promptAnh: config.promptAnh,
      config: config.config || {},
      channels: config.channels || [],
      channelStats: config.channelStats || [],
      promptStatus: config.promptStatus || {},
      topicCount: config.topicCount || 0,
      lastSheetCheckAt: Date.now(),
      sheetConnected: true
    }, callback);
  }

  function getConnectionInput() {
    const rawUrl = sheetUrlInput.value.trim();
    const split = splitWebAppUrlAndToken(rawUrl);
    return {
      url: split.url,
      token: split.token
    };
  }

  function splitWebAppUrlAndToken(url) {
    if (window.AutoPilotLib && typeof window.AutoPilotLib.splitWebAppUrlAndToken === 'function') {
      return window.AutoPilotLib.splitWebAppUrlAndToken(url);
    }
    return { url: String(url || '').trim(), token: '' };
  }

  function populateChannels(channels, selectedChannel = null, channelStats = []) {
    channelSelect.innerHTML = '';
    if (!channels || channels.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.innerText = 'Chưa tải được kênh';
      channelSelect.appendChild(opt);
      channelSelect.disabled = true;
      channelMeta.innerText = 'Bấm Kết nối hoặc Kiểm tra Sheet để tải danh sách kênh.';
      channelSelectGroup.style.display = 'block';
      return;
    }

    channels.forEach(ch => {
      const opt = document.createElement('option');
      opt.value = ch;
      const stat = findChannelStat(channelStats, ch);
      opt.innerText = stat ? `${ch} - còn ${stat.runnable || 0}/${stat.total || 0}` : ch;
      if (selectedChannel && ch === selectedChannel) {
        opt.selected = true;
      }
      channelSelect.appendChild(opt);
    });

    channelSelect.disabled = false;
    channelSelectGroup.style.display = 'block';
    updateChannelMeta(channelStats, channelSelect.value || selectedChannel || channels[0]);
  }

  channelSelect.addEventListener('change', () => {
    chrome.storage.local.get(['channelStats'], (state) => {
      updateChannelMeta(state.channelStats || [], channelSelect.value);
      chrome.storage.local.set({ selectedChannel: channelSelect.value });
    });
  });

  function findChannelStat(channelStats, channel) {
    const wanted = String(channel || '').trim().toLowerCase();
    return (channelStats || []).find(item => String(item.channel || '').trim().toLowerCase() === wanted) || null;
  }

  function updateChannelMeta(channelStats, channel) {
    if (!channelMeta) return;
    const stat = findChannelStat(channelStats, channel);
    if (!stat) {
      channelMeta.innerText = channel ? 'Chưa có thống kê cho kênh này.' : 'Chưa chọn kênh.';
      return;
    }
    channelMeta.innerText = `Còn ${stat.runnable || 0} topic, đang chạy ${stat.active || 0}, lỗi ${stat.error || 0}, đã xong ${stat.done || 0}.`;
  }

  function renderSheetPreflight(configLike) {
    if (!sheetPreflight) return;
    const channels = configLike.channels || [];
    const promptStatus = configLike.promptStatus || {};
    const channelStats = configLike.channelStats || [];
    const total = Number(configLike.topicCount || 0);
    const runnable = channelStats.reduce((sum, item) => sum + (Number(item.runnable) || 0), 0);
    const active = channelStats.reduce((sum, item) => sum + (Number(item.active) || 0), 0);
    const errors = channelStats.reduce((sum, item) => sum + (Number(item.error) || 0), 0);

    sheetPreflight.innerHTML = '';
    const rows = [
      ['Kênh đọc được', `${channels.length}`],
      ['Topic có thể chạy', `${runnable}/${total}`],
      ['Đang dở', `${active}`],
      ['Đang lỗi', `${errors}`],
      ['Prompt truyện', promptStatus.hasPromptND ? 'OK' : 'Thiếu'],
      ['Prompt ảnh', promptStatus.hasPromptAnh ? 'OK' : 'Thiếu']
    ];

    rows.forEach(([label, value]) => {
      const div = document.createElement('div');
      div.className = 'preflight-line';
      const left = document.createElement('span');
      left.innerText = label;
      const right = document.createElement('strong');
      right.innerText = value;
      div.appendChild(left);
      div.appendChild(right);
      sheetPreflight.appendChild(div);
    });
    sheetPreflight.classList.add('visible');
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
  }

  function getJobStageLabel(stage) {
    const labels = {
      script: "Viet kich ban",
      script_outline: "Tao outline",
      script_section: "Viet section",
      script_guidance: "Nhac da dang loi viet",
      image_prompt: "Tao prompt anh",
      image_prompt_repair: "Sua prompt anh"
    };
    return labels[stage] || stage || "Dang xu ly";
  }

  function getJobEventLabel(event) {
    const labels = {
      queued: "Dang xep hang gui prompt",
      waiting_for_composer: "Dang tim o nhap ChatGPT",
      composer_ready: "Da thay o nhap",
      waiting_for_send_button: "Dang cho nut gui",
      prompt_sent: "Da gui prompt",
      waiting_for_assistant: "Dang cho ChatGPT bat dau tra loi",
      assistant_started: "ChatGPT da bat dau tra loi",
      response_text: "Dang nhan noi dung",
      response_generating: "ChatGPT dang sinh tiep",
      response_waiting: "Dang doi noi dung on dinh",
      generation_stopped: "ChatGPT vua dung sinh",
      sync_generating: "Dong bo thay ChatGPT dang sinh",
      sync_generating_text: "Dong bo thay text dang co",
      progress: "Dang co tin hieu tien trinh"
    };
    return labels[event] || event || "Chua co event";
  }

  function renderActiveJobDetail(state) {
    if (!activeJobDetail) return;
    if (!state || state.status !== 'running' || !state.activeJobId) {
      activeJobDetail.innerText = "";
      activeJobDetail.classList.remove('visible');
      return;
    }

    const now = Date.now();
    const lastProgressAt = Number(state.activeJobLastProgressAt || state.activeJobStartedAt || 0);
    const lastHeartbeatAt = Number(state.activeJobLastHeartbeatAt || 0);
    const lastSyncAt = Number(state.activeJobLastSyncAt || 0);
    const startedAt = Number(state.activeJobStartedAt || 0);
    const parts = [
      getJobStageLabel(state.activeJobStage),
      getJobEventLabel(state.activeJobLastProgressEvent)
    ];

    if (state.activeJobSectionIndex) {
      parts.push(`section ${state.activeJobSectionIndex}`);
    } else if (Number.isInteger(state.activeJobParagraphIndex)) {
      parts.push(`prompt anh ${state.activeJobParagraphIndex + 1}`);
    }

    if (lastHeartbeatAt) {
      parts.push(`tin hieu ${formatDuration(now - lastHeartbeatAt)} truoc`);
    }
    if (lastProgressAt) {
      parts.push(`tien trinh that ${formatDuration(now - lastProgressAt)} truoc`);
    }
    if (lastSyncAt) {
      parts.push(`sync ${formatDuration(now - lastSyncAt)} truoc`);
    }
    if (startedAt) {
      parts.push(`chay ${formatDuration(now - startedAt)}`);
    }
    if (state.activeJobLastTextLength) {
      parts.push(`${state.activeJobLastTextLength} ky tu`);
    }
    if (state.activeJobTabHidden) {
      parts.push("tab dang an");
    }

    activeJobDetail.innerText = parts.filter(Boolean).join(" | ");
    activeJobDetail.classList.add('visible');
  }

  // 4. Logic Đồng bộ hóa & Cập nhật UI
  function updateUI(state) {
    const status = state.status || 'idle';
    const delay = state.delay || 5;
    const logs = state.logs || [];
    
    // Google Sheets State
    const sheetConnected = state.sheetConnected || false;
    const storedConnection = splitWebAppUrlAndToken(state.webAppUrl || '');
    const webAppUrl = storedConnection.url;
    const channels = state.channels || [];
    const channelStats = state.channelStats || [];
    const promptStatus = state.promptStatus || {};
    const topicCount = state.topicCount || 0;
    const selectedChannel = state.selectedChannel || '';

    // Đồng bộ dữ liệu Google Sheets
    if ((state.webAppUrl || '') && webAppUrl !== state.webAppUrl) {
      chrome.storage.local.set({
        webAppUrl
      });
    }

    if (webAppUrl && !sheetUrlInput.value) {
      sheetUrlInput.value = webAppUrl;
    }
    if (sheetRequestInFlight) {
      populateChannels(channels, selectedChannel || channels[0], channelStats);
      renderSheetPreflight({ channels, channelStats, promptStatus, topicCount });
    } else if (sheetConnected) {
      sheetConnectionStatus.innerText = "Đã kết nối";
      sheetConnectionStatus.className = "sheet-status-text connected";
      populateChannels(channels, selectedChannel || channels[0], channelStats);
      renderSheetPreflight({ channels, channelStats, promptStatus, topicCount });
    } else {
      sheetConnectionStatus.innerText = "Chưa kết nối";
      sheetConnectionStatus.className = "sheet-status-text";
      populateChannels([], null, []);
      if (sheetPreflight) sheetPreflight.classList.remove('visible');
    }

    // Nhãn Trạng thái
    statusLabel.className = `status-indicator ${status}`;
    if (status === 'idle') statusLabel.innerText = 'Sẵn sàng';
    else if (status === 'running') statusLabel.innerText = 'Đang chạy';
    else if (status === 'paused') statusLabel.innerText = 'Tạm dừng';
    else if (status === 'completed') statusLabel.innerText = 'Hoàn thành';

    // Cập nhật giá trị Delay
    delayInput.value = delay;

    if (txtFolderInput && document.activeElement !== txtFolderInput) {
      txtFolderInput.value = state.txtExportFolderUrl || '';
    }

    // Tiến trình Google Sheet
    progressText.innerText = state.sheetProgressText || `Đang chờ chạy...`;
    const percent = state.sheetProgressPercent || 0;
    progressPercent.innerText = `${percent}%`;
    progressBar.style.width = `${percent}%`;
    renderActiveJobDetail(state);

    // Vô hiệu hóa controls khi đang chạy
    const isRunningOrPaused = (status === 'running' || status === 'paused');
    delayInput.disabled = isRunningOrPaused;
    sheetUrlInput.disabled = isRunningOrPaused;
    btnConnectSheet.disabled = isRunningOrPaused;
    btnCheckSheet.disabled = isRunningOrPaused;
    if (txtFolderInput) txtFolderInput.disabled = isRunningOrPaused;
    if (btnSaveFolder) btnSaveFolder.disabled = isRunningOrPaused;
    channelSelect.disabled = isRunningOrPaused || channels.length === 0;
    btnTestRun.disabled = isRunningOrPaused || !sheetConnected || channels.length === 0;

    // Cập nhật nút bấm điều khiển
    if (status === 'running') {
      btnStart.disabled = true;
      btnPause.disabled = false;
      btnStop.disabled = false;
    } else if (status === 'paused') {
      btnStart.disabled = false;
      btnStart.innerHTML = '<span class="icon">▶</span> Tiếp tục';
      btnPause.disabled = true;
      btnStop.disabled = false;
    } else if (status === 'completed') {
      btnStart.disabled = false;
      btnStart.innerHTML = '<span class="icon">🔄</span> Chạy lại';
      btnPause.disabled = true;
      btnStop.disabled = true;
    } else { // idle
      btnStart.disabled = false;
      btnStart.innerHTML = '<span class="icon">▶</span> Chạy Bot';
      btnPause.disabled = true;
      btnStop.disabled = true;
    }

    // Hiển thị Logs
    logScreen.innerHTML = '';
    logs.forEach(log => {
      const div = document.createElement('div');
      div.className = `log-line ${log.type}`;
      div.innerText = `[${log.time}] ${log.text}`;
      logScreen.appendChild(div);
    });
    logScreen.scrollTop = logScreen.scrollHeight;

  }

  // Đọc dữ liệu từ bộ nhớ cục bộ khi load popup
  chrome.storage.local.get(null, (state) => {
    updateUI(state);
  });

  // Lắng nghe thay đổi của chrome.storage
  chrome.storage.onChanged.addListener((changes) => {
    chrome.storage.local.get(null, (state) => {
      updateUI(state);
    });
  });

  // 5. Sự kiện các nút điều khiển
  btnStart.addEventListener('click', () => {
    chrome.storage.local.get(['status', 'sheetConnected', 'webAppUrl'], (state) => {
      const currentStatus = state.status || 'idle';
      
      if (currentStatus === 'paused') {
        chrome.runtime.sendMessage({ action: "START" });
        return;
      }

      const delay = parseInt(delayInput.value) || 5;

      if (!state.sheetConnected || !state.webAppUrl) {
        alert("Vui lòng kết nối thành công Google Sheets trước khi chạy.");
        return;
      }

      const selectedCh = channelSelect.value;
      if (!selectedCh) {
        alert("Không tìm thấy Kênh nào để chạy. Hãy nhấn 'Kết nối' lại.");
        return;
      }

      // Reset và cấu hình tiến trình Google Sheet
      chrome.storage.local.set({
        delay: delay,
        completedTopicsThisRun: 0,
        runLimitTopics: 0,
        selectedChannel: selectedCh,
        sheetProgressPercent: 0,
        sheetProgressText: "Đang tìm kiếm chủ đề mới trên Google Sheet...",
        sheetWorkflowState: "GET_TOPIC",
        status: 'running',
        targetTabId: null
      }, () => {
        chrome.runtime.sendMessage({ action: "START" });
      });
    });
  });

  btnTestRun.addEventListener('click', () => {
    chrome.storage.local.get(['status', 'sheetConnected', 'webAppUrl'], (state) => {
      const currentStatus = state.status || 'idle';
      if (currentStatus === 'running' || currentStatus === 'paused') return;
      if (!state.sheetConnected || !state.webAppUrl) {
        alert("Vui lòng kết nối Google Sheets trước khi chạy thử.");
        return;
      }

      const selectedCh = channelSelect.value;
      if (!selectedCh) {
        alert("Chưa có kênh để chạy thử. Hãy bấm Kết nối hoặc Kiểm tra Sheet.");
        return;
      }

      const delay = parseInt(delayInput.value) || 5;
      chrome.storage.local.set({
        status: 'running',
        delay: delay,
        selectedChannel: selectedCh,
        targetTabId: null,
        sheetProgressText: "Đang chạy thử 1 topic...",
        sheetProgressPercent: 0,
        runLimitTopics: 1,
        completedTopicsThisRun: 0,
        sheetWorkflowState: "GET_TOPIC"
      }, () => {
        chrome.runtime.sendMessage({ action: "START" });
      });
    });
  });

  btnPause.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: "PAUSE" });
  });

  btnStop.addEventListener('click', () => {
    if (confirm("Bạn có chắc chắn muốn dừng hẳn tiến trình? Toàn bộ kết quả chưa lưu hoặc tiến trình hiện tại sẽ bị xóa khỏi bộ nhớ.")) {
      chrome.runtime.sendMessage({ action: "STOP" });
    }
  });

  btnClearLogs.addEventListener('click', () => {
    chrome.storage.local.set({ logs: [] });
  });

  function addLocalLog(text, type = 'normal') {
    chrome.storage.local.get({ logs: [] }, (data) => {
      const logs = data.logs || [];
      logs.push({ text, type, time: new Date().toLocaleTimeString() });
      if (logs.length > 100) logs.shift();
      chrome.storage.local.set({ logs });
    });
  }
});
