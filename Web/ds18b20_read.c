/* Standard C/C++ Libraries */
#include <stdio.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <stdlib.h> // Cần cho asprintf

/* FreeRTOS Libraries */
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/queue.h"
#include "freertos/event_groups.h"

/* ESP-IDF Core & System Libraries */
#include "esp_system.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_timer.h"
#include "rom/ets_sys.h"

/* ESP-IDF Driver Libraries */
#include "driver/gpio.h"

/* ESP-IDF Network Libraries */
#include "esp_netif.h"
#include "esp_event.h"
#include "esp_wifi.h"
#include "esp_now.h"
#include "mqtt_client.h"

/* Custom Component & Sensor Libraries (Giả định đã có) */
#include "ds18b20.h"
#include "mq2_sensor.h"
#include "flame_sensor.h"
#include "RCSwitch.h"


// ============================
// --- CONFIGURATION ---
// ============================

// --- General ---
#define DEVICE_ID           "TU_2_KHOCHUA"
#define LED_PIN             GPIO_NUM_2
#define SENSOR_POLL_INTERVAL_MS 2000

// --- Wi-Fi & MQTT ---
#define WIFI_SSID           "Tran Dinh Thien"
#define WIFI_PASS           "thientran55"
#define MQTT_BROKER_URI     "mqtt://pbl3.click:1883"
// Tên topic được xây dựng dynamic
#define MQTT_TOPIC_DATA_FMT     "sensor/%s/data"      
#define MQTT_TOPIC_FIRE_FMT     "sensor/%s/alert"     
#define MQTT_TOPIC_COMMAND_FMT  "sensor/%s/command"

// --- Sensor Thresholds ---
#define FIRE_THRESHOLD_C        31.2f
#define GAS_THRESHOLD_LIGHT     0       
#define GAS_THRESHOLD_STRONG    80

// --- Flame Sensor Array ---
static const gpio_num_t FLAME_SENSOR_PINS[] = {
    GPIO_NUM_13, GPIO_NUM_12, GPIO_NUM_14, GPIO_NUM_27, GPIO_NUM_26
};
#define NUM_FLAME_SENSORS (sizeof(FLAME_SENSOR_PINS) / sizeof(FLAME_SENSOR_PINS[0]))
#define FLAME_ALARM_THRESHOLD 2 // Số lượng cảm biến lửa tối thiểu để kích hoạt báo động

// --- RF Remote Control ---
#define RF_RECEIVER_PIN     GPIO_NUM_35 
#define LEARN_BUTTON_PIN    GPIO_NUM_18 
#define DELETE_BUTTON_PIN   GPIO_NUM_5  
#define NVS_NAMESPACE       "storage"   
#define MAX_RF_CODES        10          

// --- Manual Fire Control ---
#define MANUAL_ALARM_PIN    GPIO_NUM_33 
#define MANUAL_RESET_PIN    GPIO_NUM_25 


// ============================
// --- GLOBALS & TYPE DEFS ---
// ============================

static const char *TAG = "GATEWAY_FIRE_SYSTEM";
static const char *STATUS_TAG = "TRẠNG THÁI HỆ THỐNG";

// --- Network & MQTT Configuration (Được xây dựng Dynamic) ---
static char *MQTT_TOPIC_DATA = NULL;
static char *MQTT_TOPIC_FIRE = NULL;
static char *MQTT_TOPIC_COMMAND = NULL;

// --- Network & ESP-NOW ---
static const uint8_t PEER_MAC[6] = {0xA0, 0xA3, 0xB3, 0xA9, 0xE9, 0x34};
static uint8_t s_local_mac[6] = {0x78, 0x1C, 0x3C, 0x2B, 0xC5, 0x64};
static esp_mqtt_client_handle_t mqtt_client = NULL;
static bool mqtt_connected = false;
static uint8_t last_cmd_sent_espnow = 0xFF;

// --- System State Variables ---
static bool alarm_on_state = false; // The final, global alarm state
static bool led_status_state = false; // Trạng thái LED hiện tại

// --- Individual Local Alarm Source States ---
static bool g_temp_gas_fire_state = false;
static bool g_flame_consensus_fire_state = false;
static bool g_rf_triggered_fire_state = false;
static bool g_manual_triggered_fire_state = false;

// --- Flame Sensor State Array ---
static bool g_flame_sensor_states[NUM_FLAME_SENSORS];

// --- RF Control Globals ---
RCSWITCH_t rf_receiver;
unsigned long learned_rf_codes[MAX_RF_CODES] = {0};
int num_learned_codes = 0;
bool is_learning_mode = false;

// --- Data Structures ---
typedef struct {
    float temperature;
    int gas_level;
    bool combined_local_fire; // Aggregate of ALL local triggers (temp, gas, flame, RF, manual)
    bool remote_fire;         // Fire alert received from peer device
} sensor_state_t;

typedef struct __attribute__((packed)) {
    uint8_t cmd; // 0 = Safe, 1 = Fire detected
} espnow_payload_t;

// --- Shared Resources ---
static sensor_state_t sensor_data;
static SemaphoreHandle_t data_mutex;
static SemaphoreHandle_t led_mutex; // Mutex MỚI để bảo vệ led_status_state

// ============================
// --- FORWARD DECLARATIONS ---
// ============================
static void update_and_propagate_alarm_state(void);
void init_nvs();
void init_rf_control_pins();
void init_manual_control_pins();
// KHAI BÁO HÀM RF MỚI ĐƯỢC THÊM VÀO ĐỂ TRÁNH LỖI BIÊN DỊCH
bool is_code_already_learned(unsigned long code_to_check);
void save_new_code(unsigned long new_code);
void load_codes_from_nvs();
void delete_all_codes_from_nvs();


// ============================
// --- PERIPHERAL INITIALIZATION ---
// ============================

void init_nvs() {
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);
}

void init_rf_control_pins() {
    gpio_config_t io_conf = {};
    io_conf.intr_type = GPIO_INTR_DISABLE;
    io_conf.mode = GPIO_MODE_INPUT;
    io_conf.pin_bit_mask = (1ULL << LEARN_BUTTON_PIN) | (1ULL << DELETE_BUTTON_PIN);
    io_conf.pull_down_en = 0;
    io_conf.pull_up_en = 1;
    gpio_config(&io_conf);
}

void init_manual_control_pins() {
    gpio_config_t io_conf = {};
    io_conf.intr_type = GPIO_INTR_DISABLE;
    io_conf.mode = GPIO_MODE_INPUT;
    io_conf.pin_bit_mask = (1ULL << MANUAL_ALARM_PIN) | (1ULL << MANUAL_RESET_PIN);
    io_conf.pull_down_en = 0;
    io_conf.pull_up_en = 1;
    gpio_config(&io_conf);
}


// ============================
// --- RF CONTROL ---
// ============================
// (Các định nghĩa hàm RF được giữ nguyên vị trí, nhưng đã có khai báo ở trên)

bool is_code_already_learned(unsigned long code_to_check) {
    for (int i = 0; i < num_learned_codes; i++) {
        if (learned_rf_codes[i] == code_to_check) return true;
    }
    return false;
}

void save_new_code(unsigned long new_code) {
    if (num_learned_codes >= MAX_RF_CODES) {
        ESP_LOGE(TAG, "Cannot learn new code, storage is full!");
        return;
    }
    if (is_code_already_learned(new_code)) {
        ESP_LOGW(TAG, "Code %lu has already been learned.", new_code);
        return;
    }

    nvs_handle_t my_handle;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &my_handle) != ESP_OK) {
        ESP_LOGE(TAG, "Error opening NVS handle!");
        return;
    }

    char key[20];
    snprintf(key, sizeof(key), "code_%d", num_learned_codes);

    if (nvs_set_u32(my_handle, key, new_code) == ESP_OK) {
        num_learned_codes++;
        if (nvs_set_i32(my_handle, "code_count", num_learned_codes) == ESP_OK) {
            nvs_commit(my_handle);
            ESP_LOGI(TAG, "Successfully saved new code %lu. Total codes: %d", new_code, num_learned_codes);
            load_codes_from_nvs(); // Refresh RAM array (OK vì đã khai báo ở trên)
        }
    }
    nvs_close(my_handle);
}

void load_codes_from_nvs() {
    nvs_handle_t my_handle;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &my_handle) != ESP_OK) return;

    int32_t count = 0;
    nvs_get_i32(my_handle, "code_count", &count);
    num_learned_codes = count;

    if (num_learned_codes > 0) {
        ESP_LOGI(TAG, "Found %d learned RF codes. Loading...", num_learned_codes);
        for (int i = 0; i < num_learned_codes; i++) {
            char key[20];
            snprintf(key, sizeof(key), "code_%d", i);
            uint32_t temp_code = 0;
            nvs_get_u32(my_handle, key, &temp_code);
            learned_rf_codes[i] = temp_code;
            ESP_LOGI(TAG, "  -> Code %d: %lu", i, learned_rf_codes[i]);
        }
    } else {
        ESP_LOGI(TAG, "No learned RF codes found in NVS.");
    }
    nvs_close(my_handle);
}

void delete_all_codes_from_nvs() {
    nvs_handle_t my_handle;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &my_handle) != ESP_OK) return;

    nvs_erase_all(my_handle); 
    nvs_commit(my_handle);
    nvs_close(my_handle);

    memset(learned_rf_codes, 0, sizeof(learned_rf_codes));
    num_learned_codes = 0;
    ESP_LOGW(TAG, "DELETED ALL LEARNED RF CODES!");
}


// ============================
// --- FLAME SENSOR ---
// ============================

void flame_sensor_event_handler(int sensor_index, bool is_flame_detected)
{
    g_flame_sensor_states[sensor_index] = is_flame_detected;

    int active_sensors = 0;
    for (int i = 0; i < NUM_FLAME_SENSORS; i++) {
        if (g_flame_sensor_states[i] == true) {
            active_sensors++;
        }
    }

    bool new_consensus_state = (active_sensors >= FLAME_ALARM_THRESHOLD);

    if (new_consensus_state != g_flame_consensus_fire_state) {
        g_flame_consensus_fire_state = new_consensus_state;
        if (g_flame_consensus_fire_state) {
            ESP_LOGE(TAG, "FLAME ALARM: ON (Consensus from %d sensors)", active_sensors);
        } else {
            ESP_LOGI(TAG, "FLAME ALARM: OFF (Below threshold)");
        }
        update_and_propagate_alarm_state();
    }
}


// ============================
// --- ALARM CONTROL LOGIC ---
// ============================

static void send_fire_alert_espnow(uint8_t fire_flag) {
    if (fire_flag == last_cmd_sent_espnow) return;
    espnow_payload_t tx_payload = {.cmd = fire_flag};
    if (esp_now_send(PEER_MAC, (uint8_t*)&tx_payload, sizeof(tx_payload)) == ESP_OK) {
        ESP_LOGI(TAG, "Sent ESP-NOW message: {cmd: %d}", fire_flag);
        last_cmd_sent_espnow = fire_flag;
    } else {
        ESP_LOGE(TAG, "Failed to send ESP-NOW message.");
    }
}

static void update_and_propagate_alarm_state(void)
{
    bool should_publish_on = false;
    bool should_publish_off = false;

    if (xSemaphoreTake(data_mutex, portMAX_DELAY) == pdTRUE)
    {
        // Step 1: Recalculate the COMBINED LOCAL fire state from all sources
        bool new_combined_local_state = g_temp_gas_fire_state || g_flame_consensus_fire_state || g_rf_triggered_fire_state || g_manual_triggered_fire_state;

        // Step 2: If the combined local state has changed, update it and send ESP-NOW
        if (new_combined_local_state != sensor_data.combined_local_fire) {
            sensor_data.combined_local_fire = new_combined_local_state;
            send_fire_alert_espnow(sensor_data.combined_local_fire ? 1 : 0);
        }

        // Step 3: Recalculate the GLOBAL alarm state (local OR remote)
        bool is_global_fire_active = sensor_data.combined_local_fire || sensor_data.remote_fire;
        bool previous_alarm_state = alarm_on_state;

        // Step 4: Detect transition in global state and flag MQTT for publishing
        if (is_global_fire_active && !previous_alarm_state) {
            alarm_on_state = true;
            should_publish_on = true;
            ESP_LOGW(TAG, "🔥 ALARM ACTIVATED! Global fire state is now ON.");
        } else if (!is_global_fire_active && previous_alarm_state) {
            alarm_on_state = false;
            should_publish_off = true;
            ESP_LOGI(TAG, "✅ ALARM DEACTIVATED. Global fire state is now OFF.");
        }
        
        xSemaphoreGive(data_mutex);
    }

    // Step 5: Publish to MQTT if the state changed and client is connected
    if ((should_publish_on || should_publish_off) && mqtt_connected) {
        // Sử dụng topic Dynamic
        char *msg;
        if (asprintf(&msg, "{\"alert\":%s}", should_publish_on ? "true" : "false") > 0) {
            esp_mqtt_client_publish(mqtt_client, MQTT_TOPIC_FIRE, msg, 0, 1, 0);
            free(msg);
        }
    }
}

// ============================
// --- ESP-NOW ---
// ============================

static void espnow_recv_cb(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
    if (memcmp(info->src_addr, s_local_mac, 6) == 0) return;
    if (len < sizeof(espnow_payload_t)) return;

    const espnow_payload_t *rx_payload = (const espnow_payload_t*)data;
    bool new_remote_fire_state = (rx_payload->cmd == 1);
    ESP_LOGI(TAG, "ESP-NOW alert received from peer. Remote fire state: %s", new_remote_fire_state ? "ON" : "OFF");

    if (xSemaphoreTake(data_mutex, portMAX_DELAY) == pdTRUE) {
        sensor_data.remote_fire = new_remote_fire_state;
        xSemaphoreGive(data_mutex);
    }
    update_and_propagate_alarm_state();
}

static esp_err_t espnow_init_and_setup(void) {
    ESP_ERROR_CHECK(esp_now_init());
    ESP_ERROR_CHECK(esp_now_register_recv_cb(espnow_recv_cb));

    esp_now_peer_info_t peer = {0};
    memcpy(peer.peer_addr, PEER_MAC, 6);
    peer.ifidx = ESP_IF_WIFI_STA;
    peer.encrypt = false;
    
    if (esp_now_add_peer(&peer) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to add ESP-NOW peer");
        return ESP_FAIL;
    }
    return ESP_OK;
}

// ============================
// --- MQTT & WIFI ---
// ============================

/**
 * @brief Hàm xử lý lệnh điều khiển LED từ Web (topic: sensor/TU_1_NHABEP/command)
 */
static void handle_mqtt_command(const char* data, int len) {
    char cmd[32];
    if (len >= sizeof(cmd)) len = sizeof(cmd) - 1;
    strncpy(cmd, data, len);
    cmd[len] = '\0';

    if (xSemaphoreTake(led_mutex, portMAX_DELAY) == pdTRUE) { // Bảo vệ led_status_state
        if (strcmp(cmd, "LED_ON") == 0) {
            gpio_set_level(LED_PIN, 1);
            led_status_state = true;
            ESP_LOGW(TAG, "COMMAND: LED ON from Web");
        } else if (strcmp(cmd, "LED_OFF") == 0) {
            gpio_set_level(LED_PIN, 0);
            led_status_state = false;
            ESP_LOGW(TAG, "COMMAND: LED OFF from Web");
        }
        xSemaphoreGive(led_mutex);
    }
}


static void mqtt_event_handler(void *args, esp_event_base_t base, int32_t event_id, void *event_data) {
    esp_mqtt_event_handle_t event = (esp_mqtt_event_handle_t)event_data;
    if (event->event_id == MQTT_EVENT_CONNECTED) {
        mqtt_connected = true;
        ESP_LOGI(TAG, "MQTT client connected. Subscribing to commands...");
        // Đăng ký topic nhận lệnh từ Web (Topic Dynamic)
        if (MQTT_TOPIC_COMMAND) {
            esp_mqtt_client_subscribe(mqtt_client, MQTT_TOPIC_COMMAND, 1);
        }
    } else if (event->event_id == MQTT_EVENT_DISCONNECTED) {
        mqtt_connected = false;
        ESP_LOGW(TAG, "MQTT client disconnected.");
    } else if (event->event_id == MQTT_EVENT_DATA) {
        // Xử lý dữ liệu nhận được (nếu là lệnh điều khiển)
        if (MQTT_TOPIC_COMMAND && event->topic_len == strlen(MQTT_TOPIC_COMMAND) && 
            strncmp(event->topic, MQTT_TOPIC_COMMAND, event->topic_len) == 0) {
            handle_mqtt_command(event->data, event->data_len);
        }
    }
}

static void mqtt_app_init(void) {
    // Xây dựng topic names Dynamic
    asprintf(&MQTT_TOPIC_DATA, MQTT_TOPIC_DATA_FMT, DEVICE_ID);
    asprintf(&MQTT_TOPIC_FIRE, MQTT_TOPIC_FIRE_FMT, DEVICE_ID);
    asprintf(&MQTT_TOPIC_COMMAND, MQTT_TOPIC_COMMAND_FMT, DEVICE_ID);
    
    if (!MQTT_TOPIC_DATA || !MQTT_TOPIC_FIRE || !MQTT_TOPIC_COMMAND) {
        ESP_LOGE(TAG, "Failed to allocate memory for MQTT topics!");
        abort();
    }
    
    ESP_LOGI(TAG, "MQTT Data Topic: %s", MQTT_TOPIC_DATA);
    ESP_LOGI(TAG, "MQTT Command Topic: %s", MQTT_TOPIC_COMMAND);
    
    const esp_mqtt_client_config_t mqtt_cfg = { .broker.address.uri = MQTT_BROKER_URI };
    mqtt_client = esp_mqtt_client_init(&mqtt_cfg);
    esp_mqtt_client_register_event(mqtt_client, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL);
}

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t event_id, void *data) {
    if (event_id == WIFI_EVENT_STA_START || event_id == WIFI_EVENT_STA_DISCONNECTED) {
        esp_wifi_connect();
    } else if (event_id == IP_EVENT_STA_GOT_IP) {
        ESP_LOGI(TAG, "Wi-Fi connected. Starting MQTT client.");
        esp_mqtt_client_start(mqtt_client);
    }
}

static void wifi_init_sta(void) {
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, NULL));
    wifi_config_t wifi_cfg = { .sta = { .ssid = WIFI_SSID, .password = WIFI_PASS, .threshold.authmode = WIFI_AUTH_WPA2_PSK }};
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_cfg));
    ESP_ERROR_CHECK(esp_wifi_start());
}

// ============================
// --- TASKS ---
// ============================

void temp_gas_sensor_task(void *pvParameters)
{
    while (1)
    {
        float temp = ds18b20_read_temp();
        int gas = mq2_read_value();
        
        bool current_temp_gas_state = (temp > FIRE_THRESHOLD_C) || (gas > GAS_THRESHOLD_LIGHT);

        if (xSemaphoreTake(data_mutex, portMAX_DELAY) == pdTRUE) {
            sensor_data.temperature = temp;
            sensor_data.gas_level = gas;
            xSemaphoreGive(data_mutex);
        }

        if (current_temp_gas_state != g_temp_gas_fire_state) {
            g_temp_gas_fire_state = current_temp_gas_state;
            ESP_LOGW(TAG, "Temp/Gas sensor state changed to: %s", g_temp_gas_fire_state ? "DETECTED" : "CLEARED");
            update_and_propagate_alarm_state();
        }
        
        vTaskDelay(pdMS_TO_TICKS(SENSOR_POLL_INTERVAL_MS));
    }
}

void rf_control_task(void *pvParameters) {
    load_codes_from_nvs();

    while (1) {
        if (gpio_get_level(LEARN_BUTTON_PIN) == 0) {
            is_learning_mode = true;
            vTaskDelay(pdMS_TO_TICKS(500)); // Debounce
        }

        if (gpio_get_level(DELETE_BUTTON_PIN) == 0) {
            delete_all_codes_from_nvs();
            if (g_rf_triggered_fire_state) { 
                g_rf_triggered_fire_state = false;
                update_and_propagate_alarm_state();
            }
            vTaskDelay(pdMS_TO_TICKS(500)); // Debounce
        }

        if (available(&rf_receiver)) {
            unsigned long received_code = getReceivedValue(&rf_receiver);
            ESP_LOGI(TAG, "Received RF code: %lu", received_code);

            if (is_learning_mode) {
                save_new_code(received_code);
                is_learning_mode = false;
            } else {
                if (is_code_already_learned(received_code)) {
                    ESP_LOGI(TAG, "Matching RF code found! Toggling RF alarm state.");
                    g_rf_triggered_fire_state = !g_rf_triggered_fire_state;
                    update_and_propagate_alarm_state();
                }
            }
            resetAvailable(&rf_receiver);
        }

        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

void manual_control_task(void *pvParameters)
{
    while (1)
    {
        // --- Check for manual alarm trigger ---
        if (gpio_get_level(MANUAL_ALARM_PIN) == 0) {
            vTaskDelay(pdMS_TO_TICKS(20)); // Debounce delay
            if (gpio_get_level(MANUAL_ALARM_PIN) == 0) { 
                if (!g_manual_triggered_fire_state) {
                    ESP_LOGW(TAG, "MANUAL ALARM TRIGGERED!");
                    g_manual_triggered_fire_state = true;
                    update_and_propagate_alarm_state();
                }
                while(gpio_get_level(MANUAL_ALARM_PIN) == 0) { 
                    vTaskDelay(pdMS_TO_TICKS(50));
                }
            }
        }

        // --- Check for manual reset ---
        if (gpio_get_level(MANUAL_RESET_PIN) == 0) {
            vTaskDelay(pdMS_TO_TICKS(20)); // Debounce delay
            if (gpio_get_level(MANUAL_RESET_PIN) == 0) {
                ESP_LOGW(TAG, "MANUAL RESET ACTIVATED! Clearing all local and remote alarm states.");
                
                g_temp_gas_fire_state = false;
                g_flame_consensus_fire_state = false;
                g_rf_triggered_fire_state = false;
                g_manual_triggered_fire_state = false;

                if (xSemaphoreTake(data_mutex, portMAX_DELAY) == pdTRUE) {
                    sensor_data.remote_fire = false;
                    xSemaphoreGive(data_mutex);
                }

                update_and_propagate_alarm_state(); 
                
                while(gpio_get_level(MANUAL_RESET_PIN) == 0) { 
                    vTaskDelay(pdMS_TO_TICKS(50));
                }
            }
        }

        vTaskDelay(pdMS_TO_TICKS(100)); // Poll buttons every 100ms
    }
}


void led_control_task(void *pvParameters)
{
    while (1) {
        bool current_led_state = false;
        if (xSemaphoreTake(led_mutex, portMAX_DELAY) == pdTRUE) { // Đọc biến được bảo vệ
            current_led_state = led_status_state;
            xSemaphoreGive(led_mutex);
        }
        gpio_set_level(LED_PIN, current_led_state ? 1 : 0);
        vTaskDelay(pdMS_TO_TICKS(250));
    }
}

void data_publish_task(void *pv) {
    char *msg = NULL; // Dùng con trỏ, sẽ được cấp phát bằng asprintf
    
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(5000)); // Wait for 5 seconds

        float current_temp = 0.0f;
        int current_gas = 0;
        bool is_global_alert_active = false;
        bool is_gas_high = false;
        bool current_led_state = false; // Biến tạm để lấy trạng thái LED

        if (xSemaphoreTake(data_mutex, portMAX_DELAY) == pdTRUE) {
            current_temp = sensor_data.temperature;
            current_gas = sensor_data.gas_level;
            is_global_alert_active = alarm_on_state;
            xSemaphoreGive(data_mutex);
        }
        
        if (xSemaphoreTake(led_mutex, portMAX_DELAY) == pdTRUE) { // Lấy trạng thái LED
            current_led_state = led_status_state;
            xSemaphoreGive(led_mutex);
        }
        
        is_gas_high = (current_gas > GAS_THRESHOLD_LIGHT);

        // --- NEW: Build and print the consolidated status log ---
        char flame_status_str[50];
        int offset = snprintf(flame_status_str, sizeof(flame_status_str), "Flame:[");
        for (int i = 0; i < NUM_FLAME_SENSORS; i++) {
            offset += snprintf(flame_status_str + offset, sizeof(flame_status_str) - offset, " %d", g_flame_sensor_states[i] ? 1 : 0);
        }
        snprintf(flame_status_str + offset, sizeof(flame_status_str) - offset, " ]");

        ESP_LOGI(STATUS_TAG, "Nhiệt độ: %.1f°C | Gas: %d | %s | RF: %-10s | ==> BÁO ĐỘNG: %s",
             current_temp,
             current_gas,
             flame_status_str,
             is_learning_mode ? "Học Lệnh" : "Hoạt Động",
             is_global_alert_active ? "CÓ CHÁY!" : "AN TOÀN");

        // --- Publish detailed data to MQTT (Sử dụng asprintf) ---
        if (mqtt_connected && MQTT_TOPIC_DATA) {
           int len = asprintf(&msg,
                     "{\"id_thiet_bi\":\"%s\",\"nhiet_do\":%.2f,\"khi_ga\":\"%s\",\"lua\":%s,\"led_status\":%s}",
                     
                     DEVICE_ID,
                     current_temp,
                     is_gas_high ? "cao" : "thap",
                     is_global_alert_active ? "true" : "false",
                     current_led_state ? "true" : "false" // Dùng biến tạm đã được bảo vệ
                     );
            
            if (len > 0) {
                esp_mqtt_client_publish(mqtt_client, MQTT_TOPIC_DATA, msg, 0, 1, 0);
                free(msg); // Giải phóng bộ nhớ đã cấp phát bởi asprintf
                msg = NULL;
            }
        }
    }
}


// ============================
// --- APP MAIN ---
// ============================
void app_main(void) {
    // --- Initialize Core System Services ---
    init_nvs();
    data_mutex = xSemaphoreCreateMutex();
    led_mutex = xSemaphoreCreateMutex(); // Khởi tạo Mutex LED
    
    // --- Initialize Peripherals ---
    gpio_reset_pin(LED_PIN);
    gpio_set_direction(LED_PIN, GPIO_MODE_OUTPUT);
    gpio_set_level(LED_PIN, 0); 
    if (xSemaphoreTake(led_mutex, portMAX_DELAY) == pdTRUE) {
        led_status_state = false; // Đồng bộ trạng thái biến ban đầu
        xSemaphoreGive(led_mutex);
    }

    init_rf_control_pins();
    init_manual_control_pins();

    // --- Initialize Network and Protocols ---
    wifi_init_sta();
    mqtt_app_init(); // Khởi tạo topic Dynamic TẠI ĐÂY
    espnow_init_and_setup();
    
    // --- Initialize and Calibrate Sensors ---
    // RF Receiver
    initSwich(&rf_receiver);
    enableReceive(&rf_receiver, RF_RECEIVER_PIN);
    // MQ2 Gas Sensor
    mq2_init();
    ESP_LOGW(TAG, "--- Calibrating MQ2 Sensor (ensure clean air)... ---");
    // Giả định hàm mq2_calibrate() có tồn tại và hoạt động
    mq2_calibrate(); 
    ESP_LOGI(TAG, "--- MQ2 Calibration complete.");
    // Flame Sensor Array
    memset(g_flame_sensor_states, false, sizeof(g_flame_sensor_states));
    // Giả định hàm flame_sensor_init() có tồn tại và hoạt động
    flame_sensor_init(FLAME_SENSOR_PINS, NUM_FLAME_SENSORS, &flame_sensor_event_handler);

    // --- Create Application Tasks ---
    xTaskCreate(temp_gas_sensor_task, "temp_gas_task", 4096, NULL, 5, NULL);
    xTaskCreate(rf_control_task, "rf_control_task", 4096, NULL, 6, NULL);
    xTaskCreate(manual_control_task, "manual_control_task", 4096, NULL, 7, NULL); 
    xTaskCreate(led_control_task, "led_control_task", 4096, NULL, 4, NULL);
    xTaskCreate(data_publish_task, "data_publish_task", 4096, NULL, 3, NULL);
    
    ESP_LOGI(TAG, "System initialization complete. Tasks are running.");
}


