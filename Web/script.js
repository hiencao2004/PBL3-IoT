/* ======================= CẤU HÌNH CHUNG ======================= */
const MQTT_BROKER_URL = 'wss://pbl3.click/mqtt'; 
const MQTT_BASE_TOPIC = 'sensor/#';
const TEMPERATURE_ALERT_THRESHOLD = 40;
const MAX_CHART_DATA_POINTS = 10; 
const SENSOR_TIMEOUT_MS = 20000; // 60s để đánh dấu OFFLINE
const CHART_UPDATE_INTERVAL = 1000; // Giới hạn cập nhật chart 1 giây/lần

/* ======================= CẤU HÌNH CẢNH BÁO (Tối ưu) ======================= */
const ALERT_CONDITIONS = [
    // Ưu tiên 1: Lửa là nghiêm trọng nhất
    { 
        check: (data) => data.lua === true, 
        reason: "PHÁT HIỆN LỬA 🔥", 
        priority: 1 
    },
    // Ưu tiên 2: Nhiệt độ cao
    { 
        check: (data) => data.nhiet_do >= TEMPERATURE_ALERT_THRESHOLD, 
        reason: (data) => `NHIỆT ĐỘ CAO ${data.nhiet_do}°C 🌡️`, 
        priority: 2 
    },
    // Ưu tiên 3: Khí gas
    { 
        check: (data) => data.khi_ga && data.khi_ga.toLowerCase() === 'cao', 
        reason: "RÒ RỈ KHÍ GAS ☠️", 
        priority: 3 
    },
    // Ưu tiên 4: Cảnh báo RF
    { 
        check: (data) => data.rf_status === true, 
        reason: "CẢNH BÁO RF 📡", 
        priority: 4 
    }
];

/* ======================= BIẾN TRẠNG THÁI ======================= */
let currentCabinet = { id: '', name: '', location: '' };
const FIXED_DEVICES = ['TU_1_NHABEP', 'TU_2_KHOCHUA']; 

let temperatureChart;
let isRealtimeChart = true;
let cabinetDataStore = {}; 
let isAlertDismissed = false;
let lastChartUpdateTimestamp = 0;
let wakeLock = null; 
let lastNotificationTime = 0;
const renderedCabinets = new Set(); 
let lastSystemMessage = Date.now(); 

let customCabinetInfo = {}; 

let cabinetAlertState = {}; // MỚI: Theo dõi trạng thái đã thừa nhận của từng tủ

/* ======================= DOM ELEMENTS ======================= */
const mainSelection = document.getElementById('main-selection');
const detailsView = document.getElementById('details-view');
const alertModal = document.getElementById('alert-modal');
const connectionBar = document.getElementById('connection-bar');
const toastContainer = document.getElementById('toast-container');
const tempCard = document.getElementById('temp-card');
const flameCard = document.getElementById('flame-card');
const gasCard = document.getElementById('gas-card');
const rfCard = document.getElementById('rf-card');
const ledStatusDisplay = document.getElementById('led-status-display');
const alertSound = document.getElementById('alert-sound');

const editCabinetModal = document.getElementById('edit-cabinet-modal');
const editCabinetNameInput = document.getElementById('edit-cabinet-name');
const editCabinetLocInput = document.getElementById('edit-cabinet-location');

/* ======================= KHỞI TẠO ======================= */
document.addEventListener('DOMContentLoaded', () => {
    loadFromLocalStorage();
    loadCustomCabinetInfo(); 

    FIXED_DEVICES.forEach(id => {
        if (!cabinetDataStore[id]) {
            cabinetDataStore[id] = { lastData: null, chartLabels: [], chartData: [], lastSeen: 0, isOnline: false };
        }
    });

    Object.keys(cabinetDataStore).forEach(id => ensureCabinetElementExists(id));
    
    // Cập nhật trạng thái offline ban đầu
    Object.keys(cabinetDataStore).forEach(id => {
        if (!cabinetDataStore[id].isOnline) updateCabinetOnlineStatus(id, false);
    });

    initializeTemperatureChart();
    updateTime();
    setInterval(updateTime, 60000); 
    setInterval(checkSensorHealth, 5000);
    
    // Tối ưu: Kiểm tra trạng thái kết nối MQTT
    setInterval(() => {
        if (Date.now() - lastSystemMessage > 20000) updateConnectionStatus('disconnected', 'Không có kết nối');
    }, 10000);

    // Đăng ký Service Worker (PWA)
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(err => console.log('SW fail', err));
    }

    // Tương tác khởi tạo để kích hoạt Audio và Wake Lock (Bắt buộc trên di động)
    const initInteraction = async () => {
        playAlertSound(true); // Preload audio (mute)
        await requestWakeLock(); // Yêu cầu giữ màn hình sáng
        requestNotificationPermission();
        document.body.removeEventListener('click', initInteraction);
        document.body.removeEventListener('touchstart', initInteraction);
    };
    document.body.addEventListener('click', initInteraction);
    document.body.addEventListener('touchstart', initInteraction);
});

window.addEventListener('popstate', (event) => {
    if (!event.state || event.state.view !== 'details') handleBackUI();
});

/* ======================= HÀM HỆ THỐNG (PWA) ======================= */
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            const releaseWakeLock = () => { if (wakeLock) { wakeLock.release(); wakeLock = null; } };

            document.addEventListener('visibilitychange', async () => {
                if (document.visibilityState === 'visible') {
                    if (wakeLock === null) wakeLock = await navigator.wakeLock.request('screen');
                } else {
                    releaseWakeLock();
                }
            });
            if (wakeLock) wakeLock.addEventListener('release', () => { wakeLock = null; });
        }
    } catch (err) {}
}

function playAlertSound(mute = false) {
    if (!alertSound) return;
    if (mute) {
        alertSound.volume = 0;
        alertSound.play().then(() => { 
            alertSound.pause(); 
            alertSound.currentTime = 0; 
            alertSound.volume = 1; 
        }).catch(() => { });
    } else {
        alertSound.volume = 1;
        alertSound.loop = true; 
        alertSound.play().catch(() => {});
    }
}
function stopAlertSound() { if (alertSound) { alertSound.pause(); alertSound.currentTime = 0; alertSound.loop = false; } }

function requestNotificationPermission() {
    if ("Notification" in window && Notification.permission !== "granted") Notification.requestPermission();
}
function sendWebNotification(title, body, tag) {
    const now = Date.now();
    // Giới hạn thông báo 60 giây/lần
    if ("Notification" in window && Notification.permission === "granted" && (now - lastNotificationTime > 60000)) {
        try { new Notification(title, { body: body, icon: 'icon.png', tag: tag }); lastNotificationTime = now; } catch (e) { }
    }
}

/* ======================= MQTT & DATA ======================= */
updateConnectionStatus('connecting', 'Đang kết nối...');
const client = mqtt.connect(MQTT_BROKER_URL, { 
    clientId: 'web_' + Math.random().toString(16).substr(2, 8), keepalive: 60, reconnectPeriod: 2000 
});

client.on('connect', () => {
    updateConnectionStatus('connected', 'Hệ thống trực tuyến');
    showToast("Đã kết nối hệ thống", "success");
    client.subscribe(MQTT_BASE_TOPIC);
});
client.on('offline', () => updateConnectionStatus('disconnected', 'Mất kết nối máy chủ'));
client.on('error', () => updateConnectionStatus('disconnected', 'Lỗi kết nối'));

client.on('message', (topic, message) => {
    try {
        lastSystemMessage = Date.now();
        updateConnectionStatus('connected', 'Hệ thống trực tuyến');
        let data; try { data = JSON.parse(message.toString()); } catch (e) { return; }
        const id = data.id_thiet_bi;

        ensureCabinetElementExists(id);
        
        if (!cabinetDataStore[id]) { 
            cabinetDataStore[id] = { lastData: null, chartLabels: [], chartData: [], lastSeen: Date.now(), isOnline: true };
            updateCabinetOnlineStatus(id, true);
        } else {
            // Xử lý kết nối lại sau khi offline
            if (!cabinetDataStore[id].isOnline) {
                cabinetDataStore[id].isOnline = true;
                updateCabinetOnlineStatus(id, true);
                showToast(`${id} kết nối lại`, "success");
            }
        }
        
        const store = cabinetDataStore[id];
        store.lastData = data;
        store.lastSeen = Date.now();
        
        // Cập nhật dữ liệu biểu đồ
        store.chartLabels.push(new Date().toLocaleTimeString('vi-VN', {hour:'2-digit', minute:'2-digit', second:'2-digit'}));
        store.chartData.push(data.nhiet_do);
        if (store.chartLabels.length > MAX_CHART_DATA_POINTS) { store.chartLabels.shift(); store.chartData.shift(); }

        saveToLocalStorage();
        updateCabinetBadge(id, data);
        checkAlertLogic(id, data); 

        // Cập nhật giao diện chi tiết (bao gồm cả trạng thái LED)
        if (currentCabinet.id === id) {
            updateSensorUI(data); 
            if (isRealtimeChart && (Date.now() - lastChartUpdateTimestamp > CHART_UPDATE_INTERVAL)) {
                updateChartWithStoredData(store, 'none');
                lastChartUpdateTimestamp = Date.now();
            }
            if (store.isOnline && document.querySelector('.sensors-group')) document.querySelector('.sensors-group').style.opacity = '1';
        }
    } catch (e) {}
});

/* ======================= UI & LOGIC ======================= */
function checkAlertLogic(id, data) {
     let alertReason = null;
     let highestPriority = Infinity;
 
     // 1. Xác định lý do cảnh báo cao nhất (ALERT_CONDITIONS)
     for (const condition of ALERT_CONDITIONS) {
         if (condition.check(data) && condition.priority < highestPriority) {
             alertReason = typeof condition.reason === 'function' 
                             ? condition.reason(data) 
                             : condition.reason;
             highestPriority = condition.priority;
         }
     }
 
     // Lấy trạng thái cảnh báo hiện tại của tủ (Mặc định là 'safe')
     const currentState = cabinetAlertState[id] || 'safe';
 
     // === LOGIC XỬ LÝ TRẠNG THÁI (STATE MACHINE) ===
 
     if (alertReason) { 
         // TRƯỜNG HỢP CẢNH BÁO ĐANG HOẠT ĐỘNG (Dữ liệu gửi lên là ALERT)
 
         // Nếu tủ đang ở trạng thái an toàn (safe)
         if (currentState === 'safe') {
             
             // Đặt trạng thái mới là 'active' và hiển thị popup
             cabinetAlertState[id] = 'active'; 
             
             // --- KÍCH HOẠT POPUP LẦN ĐẦU CHO SỰ KIỆN MỚI ---
             showAlertScreen(id, alertReason); 
             sendWebNotification("⚠️ CẢNH BÁO!", `${alertReason} tại ${id}`, "fire-alert");
             
         } else if (currentState === 'acknowledged') {
             
             // Nếu đã được thừa nhận, chỉ cần chuyển trạng thái nội bộ thành 'active'
             // và KHÔNG hiển thị popup để không làm phiền người dùng.
             cabinetAlertState[id] = 'active';
         }
         
         // Nếu currentState là 'active', không làm gì cả (để tránh popup liên tục)
 
     } else { 
         // TRƯỜNG HỢP AN TOÀN (Dữ liệu gửi lên là SAFE)
 
         // Nếu tủ vừa mới chuyển từ trạng thái không an toàn (active/acknowledged)
         if (currentState !== 'safe') {
             // Reset trạng thái nội bộ thành 'safe'
             cabinetAlertState[id] = 'safe'; 
             isAlertDismissed = false; // Reset biến chặn popup chung (Sẵn sàng nhận cảnh báo mới)
             stopAlertSound(); // Đảm bảo nhạc tắt
         }
         
         // Nếu không có cảnh báo nào, thoát
         return; 
     }
     
     // Logic cập nhật badge vẫn chạy (vì nó nằm ngoài hàm này)
 }

function checkSensorHealth() {
     const now = Date.now();
     for (const [id, store] of Object.entries(cabinetDataStore)) {
         
         // Điều kiện: Tủ đang ONLINE VÀ đã quá thời gian chờ (SENSOR_TIMEOUT_MS)
         if (store.isOnline && now - store.lastSeen > SENSOR_TIMEOUT_MS) {
             
             store.isOnline = false;
             
             // --- BẮT ĐẦU LOGIC RESET TRẠNG THÁI CẢNH BÁO ---
             if (store.lastData) {
                 // Đặt các trạng thái cảnh báo về mức an toàn
                 store.lastData.nhiet_do = 25; 
                 store.lastData.lua = false;
                 store.lastData.khi_ga = 'thap'; 
                 store.lastData.rf_status = false; // Reset trạng thái RF
                 
                 // Kích hoạt cập nhật UI để xóa cảnh báo trên trang chính
                 updateCabinetBadge(id, store.lastData);
                 
                 // Nếu đây là tủ đang được xem
                 if (currentCabinet.id === id) {
                     updateSensorUI(store.lastData); // Cập nhật UI chi tiết
                     dismissAlert(); // Đảm bảo modal cảnh báo tắt và nhạc dừng
                 }
             }
             // --- KẾT THÚC LOGIC RESET TRẠNG THÁI CẢNH BÁO ---
 
             // Cập nhật trạng thái hiển thị MẤT TÍN HIỆU
             updateCabinetOnlineStatus(id, false);
             if (currentCabinet.id === id) { 
                 if(document.querySelector('.sensors-group')) 
                     document.querySelector('.sensors-group').style.opacity = '0.5'; 
             }
             showToast(`Mất tín hiệu từ ${id}`, "error");
             
             // Lưu trạng thái đã reset vào Local Storage
             saveToLocalStorage(); 
         }
     }
 }

function ensureCabinetElementExists(id) {
    if (renderedCabinets.has(id)) return;
    
    const existingCard = document.querySelector(`.cabinet-item[data-cabinet-id="${id}"]`);
    if (existingCard) { renderedCabinets.add(id); return; }

    const listContainer = document.querySelector('.cabinet-list');
    if (!listContainer) return;

    const newCard = document.createElement('div');
    newCard.className = 'cabinet-item fade-in';
    newCard.setAttribute('data-cabinet-id', id);
    
    const info = customCabinetInfo[id] || {};
    const defaultName = id.replace('TU_', 'Tủ ').replace(/_/g, ' '); 
    const displayName = info.name || defaultName; 
    const displayLocation = info.location || 'Giám sát khu vực';
    
    newCard.onclick = () => showDetails(displayName, displayLocation, id);

    const store = cabinetDataStore[id] || {};
    const initialStatusClass = (store.isOnline === false || store.lastSeen === 0) ? 'status-tag alert' : 'status-tag normal';
    const initialStatusText = (store.isOnline === false || store.lastSeen === 0) ? 'Không có tín hiệu' : 'Ổn định';
    const initialOpacity = (store.isOnline === false || store.lastSeen === 0) ? '0.7' : '1';
    
    newCard.style.opacity = initialOpacity;
    newCard.style.filter = (store.isOnline === false || store.lastSeen === 0) ? 'grayscale(0.8)' : 'none';

    newCard.innerHTML = `
        <div class="cab-icon blue"><i class="fas fa-wifi"></i></div>
        <div class="cab-info"><h4>${displayName}</h4><span class="cab-sub">${displayLocation}</span></div>
        <div class="cab-status"><span class="${initialStatusClass}">${initialStatusText}</span><i class="fas fa-chevron-right" style="color: #cbd5e1; font-size: 0.9rem;"></i></div>
    `;
    listContainer.appendChild(newCard);
    renderedCabinets.add(id);
}

function showDetails(name, loc, id) {
     currentCabinet = { id, name, location: loc };
     document.getElementById('details-title').innerText = name;
     
     const subtitleEl = document.getElementById('details-subtitle');
     if (subtitleEl) {
         subtitleEl.innerText = loc; 
     }
     
     // Ghi lịch sử duyệt web
     window.history.pushState({ view: 'details', id: id }, null, `#details-${id}`);
 
     const store = cabinetDataStore[id];
 
     // Cập nhật opacity dựa trên trạng thái Online/Offline
     if (document.querySelector('.sensors-group')) {
         document.querySelector('.sensors-group').style.opacity = (store && store.isOnline) ? '1' : '0.5';
     }
     
     // Đảm bảo không còn modal cảnh báo hiển thị khi chuyển trang
     if (!alertModal.classList.contains('hidden')) {
         alertModal.classList.add('hidden');
     }
     stopAlertSound(); // Đảm bảo nhạc đã tắt
 
     if (store && store.lastData) {
         // Cập nhật UI cảm biến (sẽ tự động kích hoạt Sticky Alert Bar nếu dữ liệu là ALERT)
         updateSensorUI(store.lastData); 
         updateChartWithStoredData(store, 'reset');
 
         /* * LOGIC BỊ XÓA: 
          * KHÔNG HIỂN THỊ MODAL CẢNH BÁO DỰA TRÊN DỮ LIỆU CŨ TẠI ĐÂY.
          * Việc kiểm tra cảnh báo sẽ được thực hiện bởi updateSensorUI()
          * và hiển thị trên Sticky Alert Bar.
         */
         
         // --- XÓA TOÀN BỘ ĐOẠN CODE KIỂM TRA VÀ HIỂN THỊ MODAL BÊN DƯỚI ---
         /*
         let alertReasonOnView = null;
         let highestPriority = Infinity;
 
         for (const condition of ALERT_CONDITIONS) {
             // ... logic kiểm tra ...
         }
         
         if (alertReasonOnView && !isAlertDismissed) {
              document.getElementById('alert-location').innerText = name; 
              document.getElementById('alert-device').innerText = alertReasonOnView;
              alertModal.classList.remove('hidden'); 
         }
         */
         
         
     } else { 
         // Xóa Sticky Alert nếu không có dữ liệu
         const stickyBar = document.getElementById('sticky-alert-bar');
         if(stickyBar) stickyBar.classList.add('hidden');
         
         // Hiển thị trạng thái mặc định
         updateSensorUI({nhiet_do: '--', lua: false, khi_ga: null, rf_status: false, led_status: false});
         clearChart(); 
     }
     
     mainSelection.classList.add('hidden');
     detailsView.classList.remove('hidden');
 }

function goBack() {
    if (window.history.state && window.history.state.view === 'details') window.history.back();
    else handleBackUI();
}

function handleBackUI() {
    detailsView.classList.add('hidden');
    mainSelection.classList.remove('hidden');
    stopAlertSound(); // TẮT NHẠC KHI QUAY VỀ TRANG CHÍNH
    currentCabinet = { id: '', name: '', location: '' };
}

function updateSensorUI(data) {
     if (!data) return; 
     
     const nhiet_do = data.nhiet_do !== undefined ? data.nhiet_do : '--';
     const lua = data.lua !== undefined ? data.lua : false;
     const khi_ga = data.khi_ga !== undefined ? data.khi_ga : null;
     const rf_status = data.rf_status !== undefined ? data.rf_status : false;
     const led_status = data.led_status !== undefined ? data.led_status : false;
     
     let activeAlerts = []; // Danh sách các cảnh báo đang hoạt động
     
     // 1. Cập nhật các Box và kiểm tra Alert
     
     // Nhiệt độ
     const isTempAlert = nhiet_do >= TEMPERATURE_ALERT_THRESHOLD;
     updateBox(tempCard, isTempAlert, `${nhiet_do} °C`, 'Ổn', 'Cao');
     if (isTempAlert) activeAlerts.push("NHIỆT ĐỘ");
 
     // Lửa
     const isFlameAlert = lua === true;
     updateBox(flameCard, isFlameAlert, isFlameAlert ? 'Nguy hiểm' : 'An toàn', 'Ổn', 'CHÁY');
     if (isFlameAlert) activeAlerts.push("LỬA");
 
     // Khí Gas
     const isGasAlert = khi_ga && khi_ga.toLowerCase() === 'cao';
     // Sử dụng 'thap' hoặc giá trị số nếu có để hiển thị (tùy thuộc vào cấu trúc dữ liệu của bạn)
     updateBox(gasCard, isGasAlert, khi_ga || '--', 'Ổn', 'Rò rỉ');
     if (isGasAlert) activeAlerts.push("KHÍ GAS");
 
     // Cảnh báo RF
     const isRfAlert = rf_status === true;
     updateBox(rfCard, isRfAlert, rf_status ? 'Có tín hiệu' : 'Không có tín hiệu', 'Ổn', 'Alert');
     if (isRfAlert) activeAlerts.push("CẢNH BÁO RF");
 
     // 2. Đồng bộ Trạng thái LED (Giống logic cũ)
     if (ledStatusDisplay) { 
         ledStatusDisplay.textContent = led_status ? 'Đang Bật' : 'Đang Tắt'; 
         ledStatusDisplay.className = `status-badge ${led_status ? 'on' : 'off'}`; 
     }
 
     // 3. Hiển thị Thanh cảnh báo cố định (Sticky Alert Bar)
     const stickyBar = document.getElementById('sticky-alert-bar');
     const stickyText = document.getElementById('sticky-alert-text');
     
     if (stickyBar && stickyText) {
         if (activeAlerts.length > 0) {
             stickyText.textContent = `⚠️ CẢNH BÁO: ${activeAlerts.join(', ')} Vượt Ngưỡng!`;
             stickyBar.classList.remove('hidden');
         } else {
             stickyBar.classList.add('hidden');
         }
     }
 }


function updateBox(el, isAlert, val, normTxt, alertTxt) {
    if (!el) return;
    
    const sValue = el.querySelector('.s-value');
    const sState = el.querySelector('.s-state');

    if (sValue) {
        sValue.innerText = val;
        sValue.style.color = isAlert ? '#ef4444' : 'var(--text-main)';
    }

    if (sState) {
        sState.innerText = isAlert ? alertTxt : normTxt;
        sState.className = `s-state ${isAlert ? 'alert' : 'normal'}`;
    }
}

function updateCabinetBadge(id, data) {
    if (cabinetDataStore[id] && !cabinetDataStore[id].isOnline) return; 
    
    const card = document.querySelector(`.cabinet-item[data-cabinet-id="${id}"]`);
    if (!card) return;
    const isAlert = ALERT_CONDITIONS.some(c => c.check(data));
    const tag = card.querySelector('.status-tag');
    
    const info = customCabinetInfo[id] || {};
    const defaultName = id.replace('TU_', 'Tủ ').replace(/_/g, ' '); 
    const displayName = info.name || defaultName; 
    
    const cabInfo = card.querySelector('.cab-info h4');
    if (cabInfo) cabInfo.innerText = displayName;
    
    tag.className = `status-tag ${isAlert ? 'alert' : 'normal'}`;
    tag.innerHTML = isAlert ? 'NGUY HIỂM' : 'Ổn định';
}

function updateCabinetOnlineStatus(id, isOnline) {
    const card = document.querySelector(`.cabinet-item[data-cabinet-id="${id}"]`);
    if (!card) return;
    const badge = card.querySelector('.status-tag');
    
    if (isOnline) {
        card.style.opacity = '1'; card.style.filter = 'none';
        if (badge && badge.innerText.includes("MẤT")) { 
            badge.className = 'status-tag normal'; 
            badge.innerText = 'Ổn định'; 
            badge.style.backgroundColor = ''; 
        }
    } else {
        card.style.opacity = '0.7'; card.style.filter = 'grayscale(0.8)';
        if (badge) { 
            badge.className = 'status-tag alert'; 
            badge.style.backgroundColor = '#64748b'; 
            badge.innerText = 'MẤT TÍN HIỆU'; 
        }
    }
}

/* ======================= HÀM MỚI: QUẢN LÝ TỦ & LỆNH (ĐÃ FIX ĐỒNG BỘ) ======================= */

function openEditCabinetModal() {
    if (!currentCabinet.id || !editCabinetModal) return;

    const currentCabinetIdDisplay = document.getElementById('current-cabinet-id-display');
    if (currentCabinetIdDisplay) currentCabinetIdDisplay.innerText = currentCabinet.id;

    const info = customCabinetInfo[currentCabinet.id] || {};
    const defaultName = currentCabinet.id.replace('TU_', 'Tủ ').replace(/_/g, ' ');

    editCabinetNameInput.value = info.name || defaultName;
    editCabinetLocInput.value = info.location || 'Giám sát khu vực';
    
    editCabinetModal.classList.remove('hidden');
}

function closeEditCabinetModal() {
    if (editCabinetModal) editCabinetModal.classList.add('hidden');
}

function saveCabinetInfo() {
    const id = currentCabinet.id;
    const newName = editCabinetNameInput.value.trim();
    const newLocation = editCabinetLocInput.value.trim();

    if (!newName) {
        return showToast("Tên không được để trống", "error");
    }

    customCabinetInfo[id] = { name: newName, location: newLocation };
    saveCustomCabinetInfo();

    // Cập nhật giao diện ngay lập tức
    const cabinetCard = document.querySelector(`.cabinet-item[data-cabinet-id="${id}"]`);
    if (cabinetCard) {
        cabinetCard.querySelector('.cab-info h4').innerText = newName;
        cabinetCard.querySelector('.cab-info .cab-sub').innerText = newLocation;
    }

    // Cập nhật lại biến currentCabinet và UI chi tiết
    currentCabinet.name = newName;
    currentCabinet.location = newLocation;
    document.getElementById('details-title').innerText = newName;
    
    const subtitleEl = document.getElementById('details-subtitle');
    if (subtitleEl) subtitleEl.innerText = newLocation;

    closeEditCabinetModal();
    showToast(`Đã cập nhật thông tin cho ${newName}`, "success");
}

/**
 * Gửi lệnh điều khiển qua MQTT.
 * **Bỏ logic cập nhật UI** tại đây để đồng bộ hoàn toàn qua tin nhắn phản hồi của thiết bị.
 */
function sendCommand(c) { 
    if(!currentCabinet.id) return showToast("Vui lòng chọn tủ", "error");
    
    // Gửi lệnh qua MQTT (thiết bị nhận lệnh)
    client.publish(`sensor/${currentCabinet.id}/command`, c); 
    
    const isLedOn = (c === 'LED_ON');
    showToast(`Đã gửi lệnh: ${isLedOn ? 'Bật' : 'Tắt'} đèn cho ${currentCabinet.id}. Đang chờ thiết bị phản hồi...`, "info");
}

/* ======================= CHART & UTIL ======================= */
function initializeTemperatureChart() {
    const canvas = document.getElementById('temperatureChart');
    if (!canvas) return; 
    
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0,0,0,300); 
    grad.addColorStop(0,'rgba(59,130,246,0.4)'); grad.addColorStop(1,'rgba(59,130,246,0)');
    temperatureChart = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [{ label: 'Nhiệt độ', data: [], borderColor: '#3b82f6', backgroundColor: grad, borderWidth: 3, pointRadius: 0, pointHoverRadius: 6, fill: true, tension: 0.4 }] },
        options: { 
          responsive: true, 
          maintainAspectRatio: false, 
          plugins:{ legend:{display:false} }, 
          scales:{ 
              x:{ display:false }, 
              y:{ 
                  grid:{color:'#f1f5f9'}, 
                  ticks:{color:'#64748b'},
                  
                  // === CẤU HÌNH PHẠM VI TRỤC Y ===
                  min: 0, 
                  max: 100 
              } 
          }, 
          animation: false 
      }
    });
}

function updateChartWithStoredData(store, mode='none') {
    if(temperatureChart && store) {
        temperatureChart.data.labels = [...store.chartLabels]; temperatureChart.data.datasets[0].data = [...store.chartData];
        mode==='reset' ? temperatureChart.update() : temperatureChart.update(mode);
    }
}
function clearChart() { if(temperatureChart){ temperatureChart.data.labels=[]; temperatureChart.data.datasets[0].data=[]; temperatureChart.update(); } }
function loadChartData(t) {
    const button = document.querySelector(`.t-btn[onclick*="${t}"]`);
    document.querySelectorAll('.t-btn').forEach(b=>b.classList.remove('active')); 
    if(button) button.classList.add('active');

    if(t==='realtime') { isRealtimeChart=true; const s=cabinetDataStore[currentCabinet.id]; if(s) updateChartWithStoredData(s,'reset'); }
    else { 
        isRealtimeChart=false; 
        // Dữ liệu giả định cho Lịch sử
        temperatureChart.data.labels=['10:00','11:00','12:00','13:00','14:00']; 
        temperatureChart.data.datasets[0].data=[28,29,32,30,29]; 
        temperatureChart.update(); 
    }
}

function showToast(msg, type='info') {
    const toast = document.createElement('div'); toast.className = `toast ${type}`;
    const iconClass = type==='success'?'check-circle':(type==='error'?'exclamation-circle':'info-circle');
    toast.innerHTML = `<i class="fas fa-${iconClass}"></i> <span>${msg}</span>`;
    toastContainer.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 500); }, 3000);
}
function updateConnectionStatus(status, text) {
    if(!connectionBar) return; connectionBar.className = `status-${status}`; document.getElementById('conn-text').innerText = text;
}
function showAlertScreen(loc, reason) {
    document.getElementById('alert-location').innerText = loc; 
    document.getElementById('alert-device').innerText = reason;
    alertModal.classList.remove('hidden'); 
    playAlertSound(); // CHỈ PHÁT NHẠC Ở ĐÂY (KHI CÓ DỮ LIỆU CẢNH BÁO MỚI)
}
function dismissAlert() { 
     alertModal.classList.add('hidden'); isAlertDismissed=true; stopAlertSound();
     if (currentCabinet.id) {
          // Đặt trạng thái của tủ hiện tại là Đã thừa nhận (ACK)
          cabinetAlertState[currentCabinet.id] = 'acknowledged'; 
      }
 }
function callEmergency() { window.location.href = "tel:114"; }

function saveToLocalStorage() { 
    localStorage.setItem('fireData', JSON.stringify(cabinetDataStore)); 
}
function loadFromLocalStorage() { 
    try {
        const raw = localStorage.getItem('fireData'); if (!raw) return;
        cabinetDataStore = JSON.parse(raw);
        const now = Date.now();
        for (const id in cabinetDataStore) { 
            if (!cabinetDataStore.hasOwnProperty(id)) continue;
            
            // Xóa dữ liệu biểu đồ quá 1 giờ để tiết kiệm bộ nhớ
            if (now - cabinetDataStore[id].lastSeen > 3600000) { 
                cabinetDataStore[id].chartLabels=[]; 
                cabinetDataStore[id].chartData=[]; 
            }
            
            // Khôi phục trạng thái Online/Offline
            if (now - cabinetDataStore[id].lastSeen > SENSOR_TIMEOUT_MS) {
                cabinetDataStore[id].isOnline=false;
            } else {
                cabinetDataStore[id].isOnline=true;
            }
            
            // === LOGIC MỚI: Reset trạng thái cảnh báo trong Local Storage khi khởi động ===
            if (cabinetDataStore[id].lastData) {
                // Đặt nhiệt độ, lửa, khí gas về trạng thái an toàn trong dữ liệu khởi động
                cabinetDataStore[id].lastData.nhiet_do = 25; 
                cabinetDataStore[id].lastData.lua = false;
                cabinetDataStore[id].lastData.khi_ga = 'thap';
                
                // Đảm bảo không còn trạng thái cảnh báo
                // Tuy nhiên, nếu thiết bị vật lý gửi dữ liệu cảnh báo ngay lập tức, cảnh báo sẽ xuất hiện lại.
            }
            // =========================================================================
        }
    } catch (e) { cabinetDataStore = {}; }
}

function saveCustomCabinetInfo() {
    localStorage.setItem('customCabinetInfo', JSON.stringify(customCabinetInfo));
}

function loadCustomCabinetInfo() {
    try {
        const raw = localStorage.getItem('customCabinetInfo');
        if (raw) customCabinetInfo = JSON.parse(raw);
        else customCabinetInfo = {};
    } catch (e) {
        customCabinetInfo = {};
    }
}

function updateTime() { const el=document.getElementById('current-time'); if(el) el.innerText=new Date().toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'}); }