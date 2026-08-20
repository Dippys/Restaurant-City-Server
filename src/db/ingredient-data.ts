// Ingredient catalog extracted verbatim from the client data file
// server/public/data/ingredient.xml. The hash is the opaque token the
// client sends for trades/quiz rewards (it is NOT derivable from the numeric id).
// rarity 1..5; the no* flags mark ingredients excluded from each reward channel.
export interface IngredientEntry {
  readonly id: number;
  readonly hash: string;
  readonly rarity: number;
  readonly noDaily: boolean;
  readonly noFirstTimeVisit: boolean;
  readonly noQuiz: boolean;
}

export const INGREDIENTS: readonly IngredientEntry[] = [
  { id: 4000000, hash: '3U1YuPCFbYYkyDirmWQpva', rarity: 2, noDaily: true, noFirstTimeVisit: true, noQuiz: true },
  { id: 4000001, hash: 'zTquXNtn68_n.bQGp7XiVa', rarity: 2, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000002, hash: 'DiaUr54yPWANy48rDe5jwa', rarity: 3, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000003, hash: 'RPcD2seOsl2dE6bxk5DjkW', rarity: 1, noDaily: true, noFirstTimeVisit: true, noQuiz: true },
  { id: 4000004, hash: 'jn7oj0vkTbuJkKA5QjzGda', rarity: 1, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000005, hash: 'hbvbtiywjfbtGr.DGin.uq', rarity: 4, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000006, hash: 'yj2e.JoKmpGnJVQM10SLQW', rarity: 2, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000007, hash: 'q5XhqWJgmBngmjzu.ymSya', rarity: 3, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000008, hash: 'Urt.kKSeJsWEpkO0iflOdG', rarity: 2, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000009, hash: 'vYiVhFMDKKWdgUxQ98FtZW', rarity: 3, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000010, hash: 'Yh_WRvH8JigURiYsUirc9W', rarity: 2, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000011, hash: 'qRXXOCSMh2faA5s6xd9w2q', rarity: 3, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000012, hash: 'W.bo917EZqpbPNouuPhMHa', rarity: 4, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000013, hash: '5citJlTD__mpVTc2nE05UG', rarity: 2, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000014, hash: '_nBStRqcTI8v9m4xr0WKla', rarity: 1, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000015, hash: 'Xv.8ssMv2tZ9cc5WmXR2Iq', rarity: 1, noDaily: true, noFirstTimeVisit: true, noQuiz: true },
  { id: 4000016, hash: 'OAu6mnnkxfXSW51SwWhbSa', rarity: 4, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000017, hash: 'V_nlx1mW_WQeSsgFOiytfq', rarity: 2, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000018, hash: 'NEZPWCw4WyCBmV9giSny_q', rarity: 3, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000019, hash: '5LPqrYQS7L3LOzMiVka.UG', rarity: 2, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000020, hash: 'vawlrH.UdpyrRTuzN9LEyG', rarity: 1, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000021, hash: '1j.NO9lts9rRVGgbZSerUG', rarity: 1, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000022, hash: '81wnx7e8HLTCwfpyXSucoq', rarity: 5, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000023, hash: 'IaPY28AO_KXHlGpl7rcUIq', rarity: 2, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000024, hash: 'dn5yovNc6QRAjcTpMYvSva', rarity: 1, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000025, hash: 'u3OM38wWhtsLSqprcAdHBG', rarity: 4, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000026, hash: '2t_9ueJ.X.vk98sTQadymW', rarity: 1, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000027, hash: 'g12aS5vz3twap_bW7BXo6G', rarity: 3, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000028, hash: 'YkysvOqzIjQcufyTv4Tkmq', rarity: 1, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000029, hash: 'kPtTEsL0aZ2scsmrGsT4_W', rarity: 3, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000030, hash: 'hVk9W9r9kAjWs.aw9TOHCW', rarity: 2, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000031, hash: 'E9wAatm8wxz7LUolBIkmza', rarity: 1, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000032, hash: 'y0oSKxiZQX_60YcQ45yuUG', rarity: 2, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000033, hash: 'bnP1admO0plon7Xkqtmjha', rarity: 2, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000034, hash: 'LrUFtkPiXpo_zSaiHthLhq', rarity: 1, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000035, hash: 'Zdp5lpWXy4LyX1WMYgnpMG', rarity: 3, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000036, hash: 'FLX9nQCpwcxt4CA6YNKWRa', rarity: 2, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000037, hash: 'Z3GJTXTRcuN8hldoAJQhxG', rarity: 1, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000038, hash: 'CoX70yLtIr8vp72_cWvuJW', rarity: 3, noDaily: true, noFirstTimeVisit: true, noQuiz: true },
  { id: 4000039, hash: '8VHfQaXzI7p5tpGPttXxAG', rarity: 3, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000040, hash: 'a11cr4xs2o46HX46wfXiTG', rarity: 1, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000041, hash: '5xNrfaDfB8WqpgysXLr_dq', rarity: 3, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000042, hash: 'xt8i.dlu7JYIlqrb_oBA0W', rarity: 4, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000043, hash: '4C60X7UPp1B3BW_Ncv9R5q', rarity: 5, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000044, hash: 'V6mUHrTAdrXs97hQ9xh5ba', rarity: 3, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000045, hash: 'I4gvntCI4INXZlK1EkJRPW', rarity: 4, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000046, hash: '5TETHM0jml19hshp6bTm3q', rarity: 5, noDaily: true, noFirstTimeVisit: true, noQuiz: true },
  { id: 4000047, hash: 'd6v0VKyH4Kt9lDxiorS_wa', rarity: 2, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000048, hash: 'fTxvu_A4F7xHyjmM0.cqbq', rarity: 3, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000049, hash: 'M4VTY5bbVYr6oy96a6wo1q', rarity: 1, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000050, hash: 'ZEc0UfingT6OH76I7kauNG', rarity: 2, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000051, hash: 'ccvIbwUGvNV9nOaFelD.Iq', rarity: 3, noDaily: true, noFirstTimeVisit: true, noQuiz: true },
  { id: 4000052, hash: '4jyUsa1FcmByXrXaif4z0q', rarity: 2, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000053, hash: 'AJ294ByVrm5osiWhDpNY_q', rarity: 3, noDaily: true, noFirstTimeVisit: true, noQuiz: true },
  { id: 4000054, hash: 'sXwke7u18tn_GnkcowXr2a', rarity: 3, noDaily: true, noFirstTimeVisit: true, noQuiz: true },
  { id: 4000055, hash: 'K5HB4fhvQzBA1aKt743Jcq', rarity: 4, noDaily: true, noFirstTimeVisit: true, noQuiz: true },
  { id: 4000056, hash: 'tFLeHHv9RCBYCV.Dfjhx5q', rarity: 2, noDaily: true, noFirstTimeVisit: true, noQuiz: true },
  { id: 4000057, hash: 'Bv3LgAxeHergmWKgTNJKwW', rarity: 3, noDaily: true, noFirstTimeVisit: true, noQuiz: true },
  { id: 4000058, hash: '1nlGARINApVL_zWQaEGBnG', rarity: 1, noDaily: true, noFirstTimeVisit: true, noQuiz: true },
  { id: 4000059, hash: 'bk9CQhkZppJu1SBfo3UFaG', rarity: 4, noDaily: false, noFirstTimeVisit: false, noQuiz: false },
  { id: 4000060, hash: 'QxrIYu_H97PO5VIFM2_ixq', rarity: 2, noDaily: true, noFirstTimeVisit: true, noQuiz: true },
  { id: 4000061, hash: 'CGMx24XSU.DG3t2vRTab8q', rarity: 3, noDaily: true, noFirstTimeVisit: true, noQuiz: true },
];
