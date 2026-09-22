import AMapLoader from "@amap/amap-jsapi-loader";
import type { GeoLocation } from "@/ledger/type";
import { useLedgerStore } from "@/store/ledger";
import { decodeApiKey } from "@/utils/api-key";
import { wgs84ToGcj02 } from "@/utils/geo";

/** 高德定位：返回 GCJ-02 坐标，与高德地图坐标系天然一致 */
const locateByAMap = (amapKey: string, amapSecurityCode: string) =>
    new Promise<GeoLocation>((resolve, reject) => {
        window._AMapSecurityConfig = {
            securityJsCode: amapSecurityCode,
        };
        AMapLoader.load({
            key: amapKey,
            version: "2.0",
            plugins: ["AMap.Geolocation"],
        })
            .then((AMap: typeof window.AMap) => {
                const geolocation = new AMap.Geolocation({
                    enableHighAccuracy: true,
                    timeout: 10000,
                });
                geolocation.getCurrentPosition((status, result) => {
                    if (status === "complete" && result.position) {
                        resolve({
                            latitude: result.position.lat,
                            longitude: result.position.lng,
                            accuracy: result.accuracy ?? 0,
                        });
                    } else {
                        reject(
                            new Error(result.message ?? "AMap locate failed"),
                        );
                    }
                });
            })
            .catch(reject);
    });

/** 浏览器定位：WGS-84 转 GCJ-02 后返回，避免在高德地图上出现固定偏移 */
const locateByBrowser = () =>
    new Promise<GeoLocation>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const { latitude, longitude, accuracy } = position.coords;
                const [lng, lat] = wgs84ToGcj02(longitude, latitude);
                resolve({ latitude: lat, longitude: lng, accuracy });
            },
            reject,
            {
                enableHighAccuracy: true,
                timeout: 10000, // 10秒超时
                maximumAge: 0, // 不使用缓存
            },
        );
    });

interface LocateConfig {
    amapKey?: string;
    amapSecurityCode?: string;
}

/**
 * 获取当前位置（混合定位）：
 * 优先使用传入的高德配置，未传时读取账本设置中的高德 Key；
 * 配置了高德 Key 时使用高德定位（原生 GCJ-02），失败退回浏览器定位。
 * 失败时抛出异常，由调用方决定如何降级。
 */
export const locateCurrentPosition = async (
    config?: LocateConfig,
): Promise<GeoLocation> => {
    const resolved: LocateConfig =
        config?.amapKey && config?.amapSecurityCode
            ? config
            : (() => {
                  const meta = useLedgerStore.getState().infos?.meta.map;
                  return {
                      amapKey: meta?.amapKey
                          ? decodeApiKey(meta.amapKey)
                          : undefined,
                      amapSecurityCode: meta?.amapSecurityCode
                          ? decodeApiKey(meta.amapSecurityCode)
                          : undefined,
                  };
              })();
    const hasAMapConfig = Boolean(
        resolved.amapKey && resolved.amapSecurityCode,
    );
    if (!hasAMapConfig) {
        if (!("geolocation" in navigator)) {
            throw new Error("geolocation is not supported");
        }
        return locateByBrowser();
    }
    return locateByAMap(
        resolved.amapKey as string,
        resolved.amapSecurityCode as string,
    ).catch(locateByBrowser);
};
