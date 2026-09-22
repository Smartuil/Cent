import type React from "react";
import type { ReactNode, RefObject } from "react";
import type { GeoLocation } from "@/ledger/type";
import { cn } from "@/utils";
import { locateCurrentPosition } from "@/utils/locate";

interface CurrentLocationProps {
    /** 配置了高德 Key 时优先使用高德定位（原生 GCJ-02），失败时退回浏览器定位 */
    amapKey?: string;
    amapSecurityCode?: string;
    /**
     * 当成功获取到位置信息或发生错误时触发的回调函数。
     * @param data 成功时的位置数据，如果失败则为 null。
     * @param error 失败时的错误对象，如果成功则为 null。
     */
    onValueChange?: (data: GeoLocation) => void;
    onError?: (error: GeolocationPositionError) => void;
    /** 按钮的文本内容，默认为 "获取当前位置" */
    children?: ReactNode;
    className?: string;
    ref?: RefObject<HTMLButtonElement | null>;
}

const CurrentLocation: React.FC<CurrentLocationProps> = ({
    amapKey,
    amapSecurityCode,
    onValueChange,
    onError,
    children,
    className,
    ref,
}) => {
    const hasAMapConfig = Boolean(amapKey && amapSecurityCode);

    const getLocation = async () => {
        if (!hasAMapConfig && !("geolocation" in navigator)) {
            return;
        }
        try {
            const data = await locateCurrentPosition(
                hasAMapConfig
                    ? {
                          amapKey: amapKey as string,
                          amapSecurityCode: amapSecurityCode as string,
                      }
                    : undefined,
            );
            // 成功回调
            onValueChange?.(data);
        } catch (error) {
            onError?.(error as GeolocationPositionError);
        }
    };

    if (!hasAMapConfig && !("geolocation" in navigator)) {
        return null;
    }

    return (
        <button
            ref={ref}
            type="button"
            onClick={getLocation}
            className={cn(className)}
        >
            {children}
        </button>
    );
};

export default CurrentLocation;
