/* eslint-disable @typescript-eslint/no-require-imports */
const { io } = require('socket.io-client')

const URL = 'http://localhost:3000'
const TABLE_ID = '3c20dfdb-6356-4d08-bfa9-cca61e963408'
const TOKEN_A = process.argv[2]
const TOKEN_B = process.argv[3]

const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a)

let userA_id = null, userB_id = null
let tableState = null
let testDone = false
let hasRaised = false

const socketA = io(URL, { auth: { token: TOKEN_A }, transports: ['websocket'] })
const socketB = io(URL, { auth: { token: TOKEN_B }, transports: ['websocket'] })

socketA.on('connect_error', e => log('[A] connect_error', e.message))
socketB.on('connect_error', e => log('[B] connect_error', e.message))
socketA.on('socket_error', e => log('[A] socket_error', e.message))
socketB.on('socket_error', e => log('[B] socket_error', e.message))

socketA.on('socket_ready', d => { userA_id = d.userId; log('[A] ready:', d.username, 'id='+d.userId.slice(0,8)) })
socketB.on('socket_ready', d => { userB_id = d.userId; log('[B] ready:', d.username, 'id='+d.userId.slice(0,8)) })

let _readyA = false, _readyB = false
let joinsDone = 0

socketA.on('socket_ready', () => {
  _readyA = true
  log('[TEST] A joining table')
  socketA.emit('join_table', { tableId: TABLE_ID })
})

socketB.on('socket_ready', () => {
  _readyB = true
  setTimeout(() => {
    log('[TEST] B joining table')
    socketB.emit('join_table', { tableId: TABLE_ID })
  }, 1200)
})

socketA.on('table_joined', ({ seatNumber }) => {
  log('[A] joined seat', seatNumber)
  joinsDone++
})
socketB.on('table_joined', ({ seatNumber }) => {
  log('[B] joined seat', seatNumber)
  joinsDone++
  if (joinsDone >= 2) {
    log('[TEST] Both seated — starting hand')
    setTimeout(() => socketA.emit('start_hand', { tableId: TABLE_ID }), 400)
  }
})

socketA.on('deal_cards', d => log('[A] hole cards:', d.holeCards.map(c => c.rank + c.suit[0]).join(',')))
socketB.on('deal_cards', d => log('[B] hole cards:', d.holeCards.map(c => c.rank + c.suit[0]).join(',')))

// Act when it's our turn — driven by turn_timer_start
socketA.on('turn_timer_start', ({ playerId }) => {
  log('[A] turn_timer_start playerId='+playerId.slice(0,8)+' myId='+(userA_id||'null').slice(0,8))
  if (playerId !== userA_id) return
  const hs = tableState && tableState.handState
  if (!hs) { log('[A] no handState'); return }

  const me = hs.players.find(p => p.playerId === userA_id)
  const bet = hs.currentBet
  const contrib = me ? me.roundContribution : 0
  log('[A] ACTING phase='+hs.phase+' bet='+bet+' contrib='+contrib)

  setTimeout(() => {
    if (hs.phase === 'PRE_FLOP' && bet <= 1000 && !hasRaised) {
      hasRaised = true
      log('[A] >> RAISE 3000')
      socketA.emit('player_action', { tableId: TABLE_ID, action: 'RAISE', amount: 3000 })
    } else if (bet > contrib) {
      log('[A] >> CALL')
      socketA.emit('player_action', { tableId: TABLE_ID, action: 'CALL' })
    } else {
      log('[A] >> CHECK')
      socketA.emit('player_action', { tableId: TABLE_ID, action: 'CHECK' })
    }
  }, 300)
})

socketB.on('turn_timer_start', ({ playerId }) => {
  log('[B] turn_timer_start playerId='+playerId.slice(0,8)+' myId='+(userB_id||'null').slice(0,8))
  if (playerId !== userB_id) return
  const hs = tableState && tableState.handState
  if (!hs) { log('[B] no handState'); return }

  const me = hs.players.find(p => p.playerId === userB_id)
  const bet = hs.currentBet
  const contrib = me ? me.roundContribution : 0
  log('[B] ACTING phase='+hs.phase+' bet='+bet+' contrib='+contrib)

  setTimeout(() => {
    if (bet > contrib) {
      log('[B] >> CALL')
      socketB.emit('player_action', { tableId: TABLE_ID, action: 'CALL' })
    } else {
      log('[B] >> CHECK')
      socketB.emit('player_action', { tableId: TABLE_ID, action: 'CHECK' })
    }
  }, 300)
})

socketA.on('table_state', s => {
  tableState = s
  if (s.handState) {
    const hs = s.handState
    log('[state] phase='+hs.phase, 'pot='+hs.pot, 'bet='+hs.currentBet, 'turn='+(hs.currentTurnPlayerId||'none').slice(0,8))
  }
})
socketB.on('table_state', s => { tableState = s })

socketA.on('action_result', d => log('[result]', d.action+(d.amount?' '+d.amount:''), 'by='+d.playerId.slice(0,8)))

socketA.on('showdown_result', data => {
  if (testDone) return
  testDone = true
  console.log('\n=== SHOWDOWN ===')
  console.log('reason:', data.reason, '| tipAmount:', data.tipAmount)
  data.pots.forEach((p,i) => console.log(`pot[${i}]: ${p.amount} chips → ${p.winnerHandName}`))
  data.players.forEach(p => console.log(`  ${p.username}: delta=${p.chipDelta} net=${p.netChipChange} final=${p.finalStack}`))
  
  console.log('\n=== VERIFICATION ===')
  if (data.tipAmount > 0) {
    console.log('✅ Auto rake tipAmount =', data.tipAmount)
  } else {
    console.log('ℹ️  tipAmount = 0 (no qualifying raise+call this hand)')
  }
  
  setTimeout(() => { socketA.disconnect(); socketB.disconnect(); process.exit(0) }, 500)
})

socketA.on('next_hand_countdown', ({ seconds }) => log('[next_hand_countdown]', seconds, 's'))

setTimeout(() => {
  if (!testDone) {
    log('[TEST] TIMEOUT — Current state:')
    if (tableState && tableState.handState) {
      const hs = tableState.handState
      log('  phase='+hs.phase, 'turn='+(hs.currentTurnPlayerId||'none'))
      hs.players.forEach(p => log('  player', p.playerId.slice(0,8), 'phase='+p.playerPhase, 'contrib='+p.roundContribution, 'stack='+p.stack))
    }
    socketA.disconnect(); socketB.disconnect(); process.exit(1)
  }
}, 25000)
