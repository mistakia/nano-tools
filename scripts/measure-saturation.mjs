import debug from 'debug'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { wallet, block } from 'nanocurrency-web'
import rpc from 'nano-rpc'
import WebSocket from 'ws'
import * as nanocurrency from 'nanocurrency'
import crypto from 'crypto'

import { isMain, constants } from '#common'

const argv = yargs(hideBin(process.argv)).argv
const log = debug('template')
debug.enable('template')

const getWebsocket = (wsUrl) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    ws.on('open', () => {
      resolve(ws)
    })

    ws.on('error', (error) => reject(error))
  })

const createSendBlock = async ({
  accountInfo,
  to,
  amount,
  privateKey,
  workerUrl
}) => {
  const data = {
    walletBalanceRaw: accountInfo.balance,
    fromAddress: accountInfo.account,
    toAddress: to,
    representativeAddress: constants.BURN_ACCOUNT,
    frontier: accountInfo.frontier,
    amountRaw: amount
  }

  const action = {
    action: 'work_generate',
    hash: accountInfo.frontier,
    difficulty: constants.WORK_THRESHOLD_BETA
  }
  const res = await rpc(action, { url: workerUrl })

  data.work = res.work

  return block.send(data, privateKey)
}

const createReceiveBlock = async ({
  accountInfo,
  hash,
  amount,
  privateKey,
  workerUrl
}) => {
  const data = {
    walletBalanceRaw: accountInfo.balance,
    toAddress: accountInfo.account,
    representativeAddress: constants.BURN_ACCOUNT,
    frontier: accountInfo.frontier,
    transactionHash: hash,
    amountRaw: amount
  }

  const action = {
    action: 'work_generate',
    hash: accountInfo.frontier,
    difficulty: constants.WORK_THRESHOLD_BETA
  }
  const res = await rpc(action, { url: workerUrl })

  data.work = res.work

  return block.receive(data, privateKey)
}

const createOpenBlock = async ({
  account,
  hash,
  amount,
  publicKey,
  privateKey,
  workerUrl
}) => {
  const data = {
    walletBalanceRaw: '0',
    toAddress: account,
    representativeAddress: constants.BURN_ACCOUNT,
    frontier: constants.ZEROS,
    transactionHash: hash,
    amountRaw: amount
  }

  const action = {
    action: 'work_generate',
    hash: publicKey,
    difficulty: constants.WORK_THRESHOLD_BETA
  }
  const res = await rpc(action, { url: workerUrl })

  data.work = res.work

  return block.receive(data, privateKey)
}

const createChangeBlock = async ({
  accountInfo,
  rep,
  privateKey,
  workerUrl
}) => {
  const data = {
    walletBalanceRaw: accountInfo.balance,
    address: accountInfo.account,
    representativeAddress: rep,
    frontier: accountInfo.frontier
  }

  const res = await rpc(
    {
      action: 'work_generate',
      hash: accountInfo.frontier,
      difficulty: constants.WORK_THRESHOLD_BETA
    },
    {
      url: workerUrl
    }
  )

  data.work = res.work

  return block.representative(data, privateKey)
}

// broadcasts a block and waits for its confirmation
const confirmBlock = ({ ws, block, hash, url }) =>
  new Promise((resolve, reject) => {
    // register confirmation listener
    const listener = (data) => {
      console.log(JSON.parse(data))
      const d = JSON.parse(data)
      if (d.topic !== 'confirmation') return
      if (d.message.hash !== hash) return

      // update websocket subscription
      ws.send(
        JSON.stringify({
          action: 'update',
          topic: 'confirmation',
          options: {
            accounts_del: [block.account]
          }
        })
      )

      // unregister event listener
      ws.off('message', listener)

      resolve(hash)
    }

    ws.on('message', listener)

    // register node websocket subscription
    ws.send(
      JSON.stringify({
        action: 'update',
        topic: 'confirmation',
        options: {
          accounts_add: [block.account]
        }
      })
    )

    // broadcast block
    rpc(
      {
        action: 'process',
        json_block: true,
        async: true,
        block
      },
      {
        url
      }
    )
  })

const run = async ({ seed, url, wsUrl, workerUrl }) => {
  const ws = await getWebsocket(wsUrl)
  ws.on('message', (data) => {
    // console.log(JSON.parse(data))
  })

  const start = 0
  const num_accounts = 5000
  const accounts = wallet.legacyAccounts(seed, start, num_accounts)
  const main_account = accounts.shift()
  log('main account', main_account)

  ws.send(
    JSON.stringify({
      action: 'subscribe',
      topic: 'confirmation',
      options: {
        accounts: [
          main_account.address
        ]
      }
    })
  )

  const main_account_info = await rpc(
    {
      action: 'account_info',
      account: main_account.address,
      representative: true
    },
    {
      url
    }
  )
  log('main account info', main_account_info)

  if (main_account_info.error) {
    if (main_account_info.error === 'Account not found') {
      throw new Error('Account 0 Unopened')
    } else {
      throw new Error(main_account_info.error)
    }
  }

  // verify main account balance
  if (BigInt(main_account_info.balance) < BigInt(1e30)) {
    throw new Error('Need at least 1 Nano in main account')
  }

  // open 5k accounts, starting at index 1
  const action = {
    action: 'accounts_frontiers',
    accounts: accounts.map((a) => a.address)
  }
  const res2 = await rpc(action, { url })
  log(res2)
  const amount = 1e26
  const res_values = Object.values(res2.frontiers)
  let mainFrontier = main_account_info.frontier
  let mainBalance = main_account_info.balance
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i].address
    const frontier = res_values[i]

    // check if account unopened
    if (frontier === 'error: Account not found') {
      // check if receivable exists
      const res3 = await rpc(
        {
          action: 'receivable',
          account
        },
        {
          url
        }
      )

      // create send from main account
      let sendBlock
      let sendHash
      if (!res3.blocks.length) {
        sendBlock = await createSendBlock({
          accountInfo: {
            ...main_account_info,
            frontier: mainFrontier,
            balance: mainBalance,
            account: main_account.address
          },
          to: account,
          amount,
          privateKey: main_account.privateKey,
          workerUrl
        })
        mainBalance = sendBlock.balance
        mainFrontier = sendHash = nanocurrency.hashBlock(sendBlock)

        await confirmBlock({ ws, block: sendBlock, hash: sendHash, url })
      }

      // create open for account
      const openBlock = await createOpenBlock({
        account,
        hash: sendHash || res3.blocks[0],
        amount,
        publicKey: accounts[i].publicKey,
        privateKey: accounts[i].privateKey,
        workerUrl
      })
      const openHash = nanocurrency.hashBlock(openBlock)

      await confirmBlock({ ws, block: openBlock, hash: openHash, url })
    }
  }

  // check disk for cache of blocks
  // valid previous matches frontiers
  // if needed, create 5k change blocks (1 per account)
  // save to disk

  // sample time
  // broadcast blocks
  // sample time
  // wait for 5k confirmations
  // sample time
}

const main = async () => {
  let error
  try {
    if (!argv.seed) {
      log('missing --seed')
      return
    }

    if (!argv.rpc) {
      log('missing --rpc')
      return
    }

    if (!argv.workerUrl) {
      log('missing --worker-url')
      return
    }

    await run({
      seed: argv.seed,
      url: argv.rpc,
      wsUrl: argv.wsUrl,
      workerUrl: argv.workerUrl
    })
  } catch (err) {
    error = err
    console.log(error)
  }

  process.exit()
}

if (isMain) {
  main()
}

export default run
