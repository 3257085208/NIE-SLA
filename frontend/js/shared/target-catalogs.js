const COUNTRY_CODES = `
AF AX AL DZ AS AD AO AI AQ AG AR AM AW AU AT AZ BS BH BD BB BY BE BZ BJ BM BT BO BQ BA BW BV BR IO BN BG BF BI CV KH CM CA KY CF TD CL CN CX CC CO KM CG CD CK CR CI HR CU CW CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FK FO FJ FI FR GF PF TF GA GM GE DE GH GI GR GL GD GP GU GT GG GN GW GY HT HM VA HN HK HU IS IN ID IR IQ IE IM IL IT JM JP JE JO KZ KE KI KP KR KW KG LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MH MQ MR MU YT MX FM MD MC MN ME MS MA MZ MM NA NR NP NL NC NZ NI NE NG NU NF MK MP NO OM PK PW PS PA PG PY PE PH PN PL PT PR QA RE RO RU RW BL SH KN LC MF PM VC WS SM ST SA SN RS SC SL SG SX SK SI SB SO ZA GS SS ES LK SD SR SJ SE CH SY TW TJ TZ TH TL TG TK TO TT TN TR TM TC TV UG UA AE GB US UM UY UZ VU VE VN VG VI WF EH YE ZM ZW
`.trim().split(/\s+/);

const zhRegionNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });
const enRegionNames = new Intl.DisplayNames(["en"], { type: "region" });

export const COUNTRIES = COUNTRY_CODES.map((code) => ({
  code,
  name: zhRegionNames.of(code) || code,
  englishName: enRegionNames.of(code) || code,
  flag: countryFlag(code),
})).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));

export const PROVIDERS = [
  "1GServers",
  "AbeloHost",
  "Advin Servers",
  "Aeza",
  "Airnode Hosting",
  "AkileCloud",
  "Akamai Cloud (Linode)",
  "AlexHost",
  "Alice Networks",
  "Alibaba Cloud",
  "AlphaVPS",
  "Alwyzon",
  "Amazon Web Services (AWS)",
  "AnycastIP",
  "Aruba Cloud",
  "Atlantic.Net",
  "BandwagonHost",
  "BeroHost",
  "BHost",
  "BitsFlowCloud",
  "BlueVPS",
  "BreezeHost",
  "BudgetVM",
  "BuyVM",
  "ByteVirt",
  "CeraNetworks",
  "CentrixNodes",
  "CheapWindowsVPS",
  "Cherry Servers",
  "Chunkserve",
  "CLAWCLOUD",
  "CloudBlast",
  "CloudCone",
  "Cloudflare",
  "CloudFanatic",
  "Cloudnium",
  "CloudShark",
  "Cloudzy",
  "ColoCrossing",
  "ComputeBox",
  "Contabo",
  "Crunchbits",
  "DartNode",
  "DataPacket",
  "DediRock",
  "DeluxHost",
  "DigiRDP",
  "DigitalOcean",
  "DMIT",
  "DogYun",
  "Ethernet Servers",
  "Evolution Host",
  "Evoxt",
  "ExtraVM",
  "Fachost",
  "FiberState",
  "G-Core",
  "George Datacenter",
  "Gigahost",
  "GigsGigsCloud",
  "Google Cloud",
  "GreenCloudVPS",
  "GreenWebPage",
  "Hetzner",
  "HostBrr",
  "HostCram",
  "HostDare",
  "HostDZire",
  "HostEONS",
  "HostHatch",
  "Hostishere",
  "HostMayo",
  "HostNamaste",
  "Hostodo",
  "HostSailor",
  "HostVDS",
  "HostUS",
  "HostVenom",
  "Huawei Cloud",
  "Hytron",
  "iFog",
  "iHostART",
  "IncogNET",
  "Informaten",
  "IONOS",
  "InterServer",
  "Jarland",
  "JustHost",
  "JUST.HOSTING",
  "JuHost",
  "KnownHost",
  "LayerStack",
  "Leaseweb",
  "LightLayer",
  "LightNode",
  "Little Creek Hosting",
  "Linveo",
  "LisaHost",
  "LunaNode",
  "Microsoft Azure",
  "Misaka",
  "MKCloud",
  "MyHBD",
  "Naranjatech",
  "Netcup",
  "Nexus Bytes",
  "NFP Hosting",
  "Nodion",
  "noez.de",
  "NolimitHost",
  "NOSLA",
  "NovaCloud Hosting",
  "NUXOA",
  "OneProvider",
  "Onidel",
  "OnlyServers",
  "OrangeVPS",
  "Oracle Cloud",
  "OVHcloud",
  "Ozonti",
  "PacketsDecreaser",
  "PeachVPS",
  "PQ.Hosting",
  "Privex",
  "ProviderService",
  "Psychz",
  "PureVoltage",
  "QREGnet",
  "Rabisu",
  "RackNerd",
  "Rackoona",
  "RAKsmart",
  "RamNode",
  "RansomIT",
  "RainYun",
  "RedSwitches",
  "ReliableSite",
  "RoboVPS",
  "RPiServers",
  "RuVDS",
  "Scaleway",
  "ServerCheap",
  "ServerHost",
  "ServerMania",
  "ServerPoint",
  "Servers.com",
  "Servers.Guru",
  "servaRICA",
  "Servitro",
  "SKRIME",
  "SmartHost",
  "SoftShellWeb",
  "Spartan Host",
  "SpeedyPage",
  "SVR4U",
  "Tencent Cloud",
  "Terrahost",
  "Tier.Net",
  "Time4VPS",
  "Torchbyte",
  "UCloud",
  "V.PS",
  "VDSina",
  "VirMach",
  "VM6 Networks",
  "VMISS",
  "VPSBG",
  "VPSDime",
  "VPSLAYER",
  "VPSMart",
  "Vultr",
  "WAWO",
  "WebHorizon",
  "Wishosting",
  "Worldstream",
  "xHosts",
  "Yaboola",
  "Zappie Host",
  "ZgoCloud",
  "Zouter",
].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));

export const CURRENCIES = [
  ["CNY", "人民币"],
  ["USD", "美元"],
  ["EUR", "欧元"],
  ["GBP", "英镑"],
  ["JPY", "日元"],
  ["HKD", "港币"],
  ["TWD", "新台币"],
  ["SGD", "新加坡元"],
  ["KRW", "韩元"],
  ["AUD", "澳元"],
  ["CAD", "加元"],
  ["CHF", "瑞士法郎"],
  ["NZD", "新西兰元"],
  ["RUB", "俄罗斯卢布"],
  ["INR", "印度卢比"],
  ["BRL", "巴西雷亚尔"],
  ["MXN", "墨西哥比索"],
  ["THB", "泰铢"],
  ["MYR", "马来西亚林吉特"],
  ["IDR", "印度尼西亚盾"],
  ["PHP", "菲律宾比索"],
  ["VND", "越南盾"],
  ["AED", "阿联酋迪拉姆"],
  ["TRY", "土耳其里拉"],
  ["PLN", "波兰兹罗提"],
  ["SEK", "瑞典克朗"],
  ["NOK", "挪威克朗"],
  ["DKK", "丹麦克朗"],
  ["CZK", "捷克克朗"],
  ["ZAR", "南非兰特"],
].map(([code, name]) => ({ code, name }));

export function countryFlag(code) {
  const value = String(code || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(value)) return "";
  return String.fromCodePoint(...[...value].map((letter) => letter.charCodeAt(0) + 127397));
}

export function countryFlagAsset(code) {
  const value = String(code || "").trim().toLowerCase();
  return /^[a-z]{2}$/.test(value) ? `./assets/flags/4x3/${value}.svg` : "";
}

export function countryByCode(code) {
  const value = String(code || "").trim().toUpperCase();
  return COUNTRIES.find((country) => country.code === value) || null;
}

export function normalizeCountryCode(value) {
  const raw = String(value || "").trim();
  const direct = countryByCode(raw);
  if (direct) return direct.code;
  const normalized = raw.toLocaleLowerCase("zh-CN");
  const aliases = {
    中国: "CN",
    中国大陆: "CN",
    香港: "HK",
    中国香港: "HK",
    澳门: "MO",
    中国澳门: "MO",
    台湾: "TW",
    中国台湾: "TW",
    美国: "US",
    英国: "GB",
    韩国: "KR",
    俄罗斯: "RU",
  };
  if (aliases[raw]) return aliases[raw];
  return COUNTRIES.find((country) =>
    country.name.toLocaleLowerCase("zh-CN") === normalized ||
    country.englishName.toLocaleLowerCase("en") === normalized,
  )?.code || "";
}

export function filterCountries(query) {
  const normalized = String(query || "").trim().toLocaleLowerCase("zh-CN");
  if (!normalized) return COUNTRIES;
  return COUNTRIES.filter((country) =>
    `${country.code} ${country.name} ${country.englishName}`.toLocaleLowerCase("zh-CN").includes(normalized),
  );
}

export function filterProviders(query) {
  const normalized = String(query || "").trim().toLocaleLowerCase("en");
  if (!normalized) return PROVIDERS;
  return PROVIDERS.filter((provider) => provider.toLocaleLowerCase("en").includes(normalized));
}
