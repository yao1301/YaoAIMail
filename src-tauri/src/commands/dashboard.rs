use pebble_core::PebbleError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

#[derive(Debug, Deserialize)]
struct FrankfurterResponse {
    date: String,
    rates: HashMap<String, f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardHoliday {
    pub date: String,
    pub local_name: String,
    pub name: String,
    pub country_code: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardData {
    pub exchange_date: Option<String>,
    pub usd_rates: HashMap<String, f64>,
    pub holidays: Vec<DashboardHoliday>,
    pub warnings: Vec<String>,
}

async fn fetch_holidays(
    client: &reqwest::Client,
    year: i32,
    country: &str,
) -> Result<Vec<DashboardHoliday>, reqwest::Error> {
    client
        .get(format!("https://date.nager.at/api/v3/PublicHolidays/{year}/{country}"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
}

#[tauri::command]
pub async fn get_dashboard_data(year: i32) -> Result<DashboardData, PebbleError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("YaoAIMail/1.1")
        .build()
        .map_err(|error| PebbleError::Network(error.to_string()))?;
    let exchange_request = client
        .get("https://api.frankfurter.app/latest?from=USD&to=CNY,EUR,GBP,HKD,JPY")
        .send();
    let (exchange, cn, gb, us) = tokio::join!(
        exchange_request,
        fetch_holidays(&client, year, "CN"),
        fetch_holidays(&client, year, "GB"),
        fetch_holidays(&client, year, "US"),
    );

    let mut warnings = Vec::new();
    let (exchange_date, usd_rates) = match exchange {
        Ok(response) => match response.error_for_status() {
            Ok(response) => match response.json::<FrankfurterResponse>().await {
                Ok(data) => (Some(data.date), data.rates),
                Err(error) => {
                    warnings.push(format!("汇率数据解析失败：{error}"));
                    (None, HashMap::new())
                }
            },
            Err(error) => {
                warnings.push(format!("汇率服务暂时不可用：{error}"));
                (None, HashMap::new())
            }
        },
        Err(error) => {
            warnings.push(format!("汇率服务连接失败：{error}"));
            (None, HashMap::new())
        }
    };

    let mut holidays = Vec::new();
    for (country, result) in [("中国", cn), ("英国", gb), ("美国", us)] {
        match result {
            Ok(mut items) => holidays.append(&mut items),
            Err(error) => warnings.push(format!("{country}节假日数据获取失败：{error}")),
        }
    }
    holidays.sort_by(|left, right| left.date.cmp(&right.date));

    Ok(DashboardData {
        exchange_date,
        usd_rates,
        holidays,
        warnings,
    })
}
