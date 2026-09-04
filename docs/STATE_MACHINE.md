# 状態機械

ROS2 Visual Starterは、UI操作、ROS接続、map、Navigation、Exploration、Vision、Object Searchを`src/appState.ts`の`AppState`で一元管理します。`transitionAppState(state, event)`は純粋な遷移として次stateと`AppEffect[]`を返し、DOM、ROS、fetchなどの副作用は呼び出し側が実行します。

## 共通原則

1. runtime切替中、map reset中、必要な接続がない間は操作をlockする。
2. runtime、map、transport、Vision、探索ごとのcycleまたはgenerationが一致しないcallbackはrejectする。
3. runtime切替、接続喪失、画面切替、操作権喪失、安全停止ではgoal取消、入力解除、速度0を優先する。
4. NavigationとExplorationはfresh map／poseとROS graph readinessを確認してから進める。
5. Object Searchは探索、Vision、Depth、停止後の再確認を別々の証拠として扱う。

## AppStateの領域

| 領域 | 主な状態 | 役割 |
| --- | --- | --- |
| `runtime` | `stable`, `switching`, `error` | SIMとROS runtime modeの切替 |
| `map` | `unavailable`, `initializing`, `ready`, `resetting`, `error` | map／pose／Navigation readiness |
| `command` | `manual`, `navigation`, `stopped` | 速度sourceの所有権 |
| `navigation` | `idle`, `sending`, `moving`, `succeeded`, `canceled`, `failed` | 1つのNav2 goal |
| `exploration` | `idle`から`completed`または`error`まで | frontier選択とreplan |
| `vision` | `unavailable`, `initializing`, `ready`, `error` | model、Camera、Detectionの同期状態 |
| `objectSearch` | `idle`から`succeeded`／`not_found`まで | 物体探索mission |
| `view` | `sim`, `stage` | 走行画面と編集画面の排他 |
| `controlLease` | ownerとgeneration | 操作できるBrowser clientの管理 |
| `safety` | stopped flag | Safety Controllerの停止状態 |

## Runtime

```text
stable(current)
  └─ RUNTIME_SWITCH_REQUESTED
       └─ switching(current -> target)
            ├─ manager reports target ready ──> stable(target)
            └─ manager reports error ─────────> error
```

runtime modeは`sim`, `base`, `mapping`, `navigation`, `exploration`です。利用者向けの`--ros`は`base`へ対応します。

切替開始時は操作入力を解放し、active goalを取り消し、速度0を出し、古いgoal／map／exploration dataを消去します。Backendが予期せず停止した場合はSIM表示へ戻し、errorを画面へ出します。

## Map readiness

```text
unavailable
  └─ ROS mode開始 ──> initializing
                         ├─ map + pose + required Navigation ready ──> ready
                         └─ failure ─────────────────────────────────> error

ready ── reset requested ──> resetting ── success ──> initializing
                                      └─ failure ───> error
```

- `mapping`はmapとposeを待ちます。
- `navigation`は保存地図、localization、Nav2 readinessを待ちます。
- `exploration`はlive map、SLAM pose、Nav2 readinessを待ちます。
- `navigation-health`再確認中は安全な範囲で状態表示を更新しますが、古い証拠で新しい探索を開始しません。

## Command ownershipとNavigation

Command ownershipはBrowser stateとROS側Command Gateの観測が一致してから確定します。owner切替待ちは750 msでtimeoutし、Navigation開始を中断します。

```text
idle ── goal requested ──> sending ── accepted/feedback ──> moving
 moving ── result success ──> succeeded
 moving ── cancel ──────────> canceled
 sending/moving ── error ───> failed
```

Navigationを開始できるのは次をすべて満たす場合です。

- runtimeが`navigation`または`exploration`でstable
- Transportが`CONNECTED`
- 同じruntime modeのmapが`ready`
- SIM view
- Safety stopが解除済み
- このBrowserが操作権を所有

実際の速度は`/cmd_vel_nav`からCommand Gate、`/cmd_vel_raw`からSafety Controllerを通ります。

## Exploration

```text
idle/completed
  └─ start ──> evaluating ── candidate ──> sending ──> moving
                   ▲                              │
                   └──── replanning <── result ──┘

active ── unsafe/unavailable/user ──> paused ── explicit resume ──> evaluating
active ── bounded failure ──────────> error
active ── coverage + no candidate confirmation ──> completed
```

`evaluating`ではOccupancyGridからfrontier clusterを作り、known free cell、robot clearance、到達距離、情報量、blacklistを評価します。通常候補が停滞または枯渇した場合はcorner sweepへ切り替えます。

goal成功、失敗、取消、stale transform、Navigation recovery、新しいmapは`replanning`の理由になります。失敗候補はcooldown付きblacklistへ記録し、retryは最大8回です。

完了には、観測済みcell比率90%以上と、候補なしの連続確認が必要です。利用者が停止を選んだ場合、90%未満では完了扱いにせず、安全にgoalを取り消して終了します。

pauseの代表例は、利用者操作、原点reset、manual override、Safety stop、Navigation unavailable、操作権喪失、STAGE移行、runtime切替、Transport切断です。再開はfresh mapとfresh poseを再確認した後だけ受け付けます。

## Vision readiness

Visionはmodel status、Camera frame、Detection応答を独立して観測します。frameとDetectionが500 ms以内で対応し、必要なtimestampが現在cycleに属するときだけ`ready`になります。

- Camera frameのfreshness: 1秒
- detector status／応答のfreshness: 2秒
- runtime、Transport、map resetでcycleを更新し、過去のDetectionを無効化

## Object Search

```text
idle
  └─ accepted command ──> preparing ── readiness ──> searching
                                                   │
                                  stable detection ▼
                                               candidate
                                      ┌────────────┴────────────┐
                                already in range          safe approach goal
                                      │                         ▼
                                      │                    approaching
                                      └────────────┬────────────┘
                                                   ▼
                                                stopping
                                                   ▼
                                               confirming
                                          ┌────────┴────────┐
                                      succeeded          paused/error

searching ── exploration completed ──> finalizing ── fresh Vision ──> not_found
```

`preparing`は必要ならruntimeを`exploration`へ切り替え、以前のVision証拠を破棄します。`searching`はObject Search用のfrontier policyで移動します。

Detection候補はmission開始後のfresh frameだけを使い、class、confidence、bbox、Depth、cycleを検査します。現在の実装は停止前5 frame中3回のhitで候補とし、対象が5 m以内なら接近goalを追加せず停止へ進みます。遠い対象へはknown free cellとclearanceを満たすNav2 goalだけを作成します。

停止時はgoal取消、manual owner、速度0を観測し、その後の新しいCamera frameで3 frame中2回のhitを確認して成功にします。停止前のDetectionを成功確認へ再利用しません。

Safety stop、Transport切断、runtime変更、操作権喪失、STAGE移行、manual override、Vision不良ではpauseします。再開は利用者の明示操作とfreshなmap／pose／Visionが必要です。取消は探索とNavigationを止め、速度0へ戻します。

## Effect

代表的な`AppEffect`は次のとおりです。

- `ZERO_VELOCITY`
- `CANCEL_NAVIGATION_GOAL`
- `SET_COMMAND_OWNER`
- `REQUEST_RUNTIME`
- `REQUEST_MAP_RESET`
- `SEND_NAVIGATION_GOAL`
- `EVALUATE_EXPLORATION_MAP`
- `WAIT_FOR_EXPLORATION_MAP`
- `ENTER_STAGE`／`EXIT_STAGE`
- `SYNC_OBJECT_SEARCH_CHAT`

新しい非同期処理を追加するときは、直接stateを書き換えず、開始event、generation付き完了event、必要なeffect、古い完了eventのreject testを追加してください。
