import dayjs, { type Dayjs } from "dayjs";
import isSameOrAfter from "dayjs/plugin/isSameOrAfter";
import isSameOrBefore from "dayjs/plugin/isSameOrBefore";
import { numberToAmount } from "./bill";

dayjs.extend(isSameOrBefore);
dayjs.extend(isSameOrAfter);

import { DefaultCurrencyId as DefaultBaseCurrencyId } from "@/api/currency/currencies";
import enMessages from "@/locale/lang/en.json";
import zhMessages from "@/locale/lang/zh.json";
import { BillCategories } from "./category";
import {
    type CompiledAST,
    compileFilterQuery,
    type FilterQueryContext,
    isFilterQuery,
    matchFilterQuery,
    parseFilterQuery,
} from "./filter-query";
import type { Bill, BillCategory, BillFilter, BillType } from "./type";

const isTypeMatched = (bill: Bill, type?: BillType) => {
    if (type === undefined) return true;
    return bill.type === type;
};

export const isTimeMatched = (
    bill: Bill,
    _start?: Dayjs | string | number,
    _end?: Dayjs | string | number,
    recent?: BillFilter["recent"],
) => {
    const d = dayjs.unix(bill.time / 1000);
    const { start, end } = (() => {
        if (recent) {
            const now = dayjs();
            return {
                start: now.subtract(recent.value, recent.unit).startOf("day"),
                end: undefined,
            };
        }
        const start =
            _start === undefined
                ? undefined
                : typeof _start === "number"
                  ? dayjs.unix(_start / 1000)
                  : dayjs(_start);
        const end =
            _end === undefined
                ? undefined
                : typeof _end === "number"
                  ? dayjs.unix(_end / 1000)
                  : dayjs(_end);
        return { start, end };
    })();
    if (start) {
        if (end) {
            return d.isSameOrAfter(start) && d.isSameOrBefore(end);
        }
        return d.isSameOrAfter(start);
    }
    if (end) {
        return d.isSameOrBefore(end);
    }
    return true;
};

const isMoneyMatched = (
    bill: Bill,
    _minNumber = -Infinity,
    _maxNumber = Infinity,
) => {
    const _min = numberToAmount(_minNumber);
    const _max = numberToAmount(_maxNumber);
    const [min, max] = _min < _max ? [_min, _max] : [_max, _min];
    return bill.amount <= max && bill.amount >= min;
};
const isUserMatched = (bill: Bill, uids?: (string | number)[]) => {
    return uids?.length ? uids.some((u) => bill.creatorId === u) : true;
};
const isCateMatched = (bill: Bill, cates?: string[]) => {
    return cates?.length ? cates.some((c) => bill.categoryId === c) : true;
};

/** 分类名的可搜索变体：原始名 + 中英文翻译（转小写） */
const categoryNameVariants = (name: string): string[] => {
    const zh = (zhMessages as Record<string, string>)[name];
    const en = (enMessages as Record<string, string>)[name];
    return Array.from(new Set([name, zh, en]))
        .filter((v): v is string => Boolean(v))
        .map((v) => v.toLowerCase());
};

/** 建立 categoryId -> 分类名变体（含父分类名）的索引，用于普通关键词搜索命中分类 */
const buildCategoryNameIndex = (
    categories: ReadonlyArray<Pick<BillCategory, "id" | "name" | "parent">>,
): Map<string, string[]> => {
    const byId = new Map<string, string[]>();
    for (const c of categories) {
        byId.set(c.id, categoryNameVariants(c.name));
    }
    // 父分类名并入子分类：搜索父分类名（如“汽车”）也能命中其子分类下的账单
    for (const c of categories) {
        if (!c.parent) continue;
        const merged = new Set(byId.get(c.id));
        let current: string | undefined = c.parent;
        const visited = new Set<string>();
        while (current && !visited.has(current)) {
            visited.add(current);
            for (const n of byId.get(current) ?? []) {
                merged.add(n);
            }
            current = categories.find((x) => x.id === current)?.parent;
        }
        byId.set(c.id, [...merged]);
    }
    return byId;
};

const isPlainCommentMatched = (
    bill: Bill,
    comment?: string,
    categoryNames?: Map<string, string[]>,
) => {
    if (!comment) return true;
    const keyword = comment.toLowerCase();
    if (bill.comment?.toLowerCase().includes(keyword)) return true;
    // 关键词同时匹配分类名称（含父分类、含中英文翻译）
    return (
        categoryNames?.get(bill.categoryId)?.some((n) => n.includes(keyword)) ??
        false
    );
};

const isAssetsMatched = (bill: Bill, assets?: boolean) => {
    return assets === true ? bill.images?.some((img) => Boolean(img)) : true;
};

const isScheduledMatched = (bill: Bill, scheduled?: boolean) => {
    return scheduled === true ? bill.extra?.scheduledId : true;
};

const isTagsMatched = (bill: Bill, tagIds?: string[]) => {
    return tagIds?.length
        ? tagIds.some((c) => bill.tagIds?.some((t) => t === c))
        : true;
};

const isExcludeTagsMatched = (bill: Bill, tagIds?: string[]) => {
    if ((tagIds?.length ?? 0) === 0) {
        return true;
    }
    return tagIds?.every((excludeTag) => !bill.tagIds?.includes(excludeTag));
};

const isCurrenciesMatched = (
    bill: Bill,
    base: string,
    currencies?: string[],
) => {
    return currencies?.length
        ? currencies.some((c) => (bill.currency?.target ?? base) === c)
        : true;
};

/**
 * 创建一个 bill 匹配器闭包：parse + compile 在此一次性完成，
 * 返回的函数对每个 bill 仅做求值，无重复解析开销。
 *
 * 设计意图：保持纯函数式管道（context 显式传入），同时让热路径
 * （worker、measurement、UI 列表过滤）维持高性能。
 */
export const createBillMatcher = (
    filter: BillFilter,
    ctx?: FilterQueryContext,
): ((bill: Bill) => boolean) => {
    console.log("start filter:", filter, ctx);
    const compiledQuery: CompiledAST | null =
        filter.comment && isFilterQuery(filter.comment)
            ? compileFilterQuery(parseFilterQuery(filter.comment), ctx ?? {})
            : null;
    const baseCurrency = filter.baseCurrency ?? DefaultBaseCurrencyId;
    const categoryNames = buildCategoryNameIndex(
        ctx?.categories?.length ? ctx.categories : BillCategories,
    );
    return (bill) =>
        Boolean(
            isTypeMatched(bill, filter.type) &&
                isUserMatched(bill, filter.creators) &&
                isCateMatched(bill, filter.categories) &&
                isMoneyMatched(
                    bill,
                    filter.minAmountNumber,
                    filter.maxAmountNumber,
                ) &&
                isTimeMatched(bill, filter.start, filter.end, filter.recent) &&
                Boolean(isAssetsMatched(bill, filter.assets)) &&
                Boolean(isScheduledMatched(bill, filter.scheduled)) &&
                (compiledQuery
                    ? matchFilterQuery(compiledQuery, bill)
                    : isPlainCommentMatched(
                          bill,
                          filter.comment,
                          categoryNames,
                      )) &&
                isTagsMatched(bill, filter.tags) &&
                isCurrenciesMatched(bill, baseCurrency, filter.currencies) &&
                isExcludeTagsMatched(bill, filter.excludeTags),
        );
};

export const isBillMatched = (
    bill: Bill,
    filter: BillFilter,
    ctx?: FilterQueryContext,
) => createBillMatcher(filter, ctx)(bill);

export const treeCategories = (categories: BillCategory[]) => {
    // 1. 创建一个 Map 存储所有节点，并预设 children 属性
    const itemMap = new Map<
        string,
        BillCategory & { children: BillCategory[] }
    >();

    for (const cat of categories) {
        itemMap.set(cat.id, { ...cat, children: [] });
    }

    const result: (BillCategory & { children: BillCategory[] })[] = [];

    // 2. 建立层级关系
    for (const cat of categories) {
        const item = itemMap.get(cat.id)!;

        if (!cat.parent) {
            // 如果没有父级，说明是根节点
            result.push(item);
        } else {
            // 找到父级并把当前项加入父级的 children 中
            const parentItem = itemMap.get(cat.parent);
            if (parentItem) {
                parentItem.children.push(item);
            } else {
                // 情况处理：如果数据中引用了不存在的父 ID，可根据业务需求决定是否作为根节点
                result.push(item);
            }
        }
    }

    return result;
};

/** 检查target 分类是否与source分类相同，或者是source的子类 */
export const isSameOrChildCategory = (
    source: string,
    target: string,
    allCategories: BillCategory[],
) => {
    const targetCategory = allCategories.find((c) => c.id === target);
    if (!targetCategory || !targetCategory.parent) {
        return source === target;
    }

    return source === targetCategory.parent;
};

export const intlCategory = <
    T extends Pick<BillCategory, "customName" | "name"> | undefined,
>(
    c: T,
    t: any,
): T => {
    if (c === undefined) {
        return c;
    }
    return { ...c, name: c.customName ? c.name : t(c.name) };
};

export const categoriesGridClassName = (cs: BillCategory[] | undefined) =>
    cs?.some((v) => v.name.length > 2)
        ? "grid-cols-[repeat(auto-fill,minmax(120px,1fr))]"
        : "grid-cols-[repeat(auto-fill,minmax(80px,1fr))]";

/**
 * 属性合并辅助函数：处理 A, B, Default 三者之间的冲突
 */
function mergeProperties(
    key: keyof BillCategory,
    valA: any,
    valB: any,
    valD: any,
): any {
    // 1. 如果 B 中没有该属性，或者值完全一样，保留 A 的值（或者 B 的值，反正一样）
    if (valB === undefined || valA === valB) {
        return valA;
    }

    // 2. 如果没有默认值参考，直接以 B 为准 (覆盖模式)
    if (valD === undefined) {
        return valB;
    }

    // 3. 三方比对逻辑
    const isAChanged = valA !== valD;
    const isBChanged = valB !== valD;

    if (isAChanged && !isBChanged) {
        // A 改了，B 没改 -> 用户想保留自己的修改，忽略 B 的默认值
        return valA;
    } else if (!isAChanged && isBChanged) {
        // A 没改，B 改了 -> 应用 B 的更新
        return valB;
    } else {
        // 冲突：A 和 B 都改了，或者都没改
        // 规则："重复元素以B中的为准"
        return valB;
    }
}

/**
 * 核心合并函数
 * @param categoriesA 本地数组 (决定排序优先)
 * @param categoriesB 新数组 (提供新数据和新元素)
 * @param defaultCategories 默认配置数组 (用于比对差异)
 */
export function appendCategories(
    categoriesA: BillCategory[],
    categoriesB: BillCategory[],
    defaultCategories: BillCategory[] = BillCategories,
): BillCategory[] {
    // 1. 建立索引，优化查找速度
    const mapB = new Map(categoriesB.map((c) => [c.id, c]));
    const mapDefault = new Map(defaultCategories.map((c) => [c.id, c]));

    // 记录 A 中已有的 ID，用于后续找出 B 的新增项
    const idsInA = new Set<string>();

    // 2. 遍历 A (保留 A 的顺序)
    const mergedList = categoriesA.map((itemA) => {
        idsInA.add(itemA.id);

        const itemB = mapB.get(itemA.id);

        // 情况 1: B 中没有这个 ID -> 完全保留 A
        if (!itemB) {
            return itemA;
        }

        // 情况 2: A 和 B 都有 -> 进行属性合并
        const itemDefault = mapDefault.get(itemA.id);

        // 创建一个新对象，以 A 为底
        const finalItem: BillCategory = { ...itemA };

        // 遍历 B 的所有属性，尝试覆盖或合并到 finalItem
        // 使用 keyof 确保类型安全
        (Object.keys(itemB) as Array<keyof BillCategory>).forEach((key) => {
            const valA = itemA[key];
            const valB = itemB[key];
            // 注意：如果 default 中没有这个元素，valD 为 undefined
            const valD = itemDefault ? itemDefault[key] : undefined;

            (finalItem as any)[key] = mergeProperties(key, valA, valB, valD);
        });

        return finalItem;
    });

    // 3. 处理 B 中的新增项 (B 中有，但 A 中没有的 ID)
    // 规则："B中新增的元素按照B中原有的顺序排列在A后面"
    const newItemsFromB = categoriesB.filter((itemB) => !idsInA.has(itemB.id));

    // 4. 合并结果
    return [...mergedList, ...newItemsFromB];
}
