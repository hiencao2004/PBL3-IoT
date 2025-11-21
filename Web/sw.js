/* ======================= SERVICE WORKER - PHIÊN BẢN V4 ======================= */
// Tăng phiên bản để kích hoạt cập nhật cache
const CACHE_NAME = 'fire-alarm-v4'; 
const ASSETS = [
    './', 
    './index.html', 
    './style.css', 
    './script.js', 
    './icon.png', 
    './alert.mp3', 
    './manifest.json',
    // Thư viện bên ngoài
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.2/css/all.min.css',
    'https://cdn.jsdelivr.net/npm/chart.js',
    'https://unpkg.com/mqtt/dist/mqtt.min.js'
];

// Sự kiện Install: Cache tất cả các tệp cần thiết
self.addEventListener('install', (e) => { 
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[Service Worker] Caching all app shell assets');
            return cache.addAll(ASSETS);
        }).catch(err => {
            console.error('[Service Worker] Error caching assets:', err);
        })
    ); 
    self.skipWaiting();
});

// Sự kiện Activate: Dọn dẹp Cache cũ
self.addEventListener('activate', (e) => {
    const cacheWhitelist = [CACHE_NAME];
    e.waitUntil(
        caches.keys().then((cacheNames) =>
            Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheWhitelist.indexOf(cacheName) === -1) {
                        console.log(`[Service Worker] Deleting old cache: ${cacheName}`);
                        return caches.delete(cacheName);
                    }
                })
            )
        )
    );
    return self.clients.claim();
});

// Sự kiện Fetch: Chiến lược Cache-First
self.addEventListener('fetch', (e) => { 
    if (e.request.method !== 'GET') {
        return;
    }

    e.respondWith(
        caches.match(e.request).then((response) => {
            if (response) {
                return response;
            }
            
            return fetch(e.request).catch(() => {
                // Có thể thêm logic trả về trang offline tại đây nếu cần
            });
        })
    ); 
});