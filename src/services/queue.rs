use std::{
    collections::HashMap,
    future::Future,
    panic::AssertUnwindSafe,
    pin::Pin,
    sync::{Arc, Mutex},
};

use anyhow::{Result, bail};
use futures_util::FutureExt;
use tokio::sync::{Notify, mpsc};

type Job = Pin<Box<dyn Future<Output = ()> + Send>>;

#[derive(Clone, Default)]
pub struct PerUserQueue {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    state: Mutex<State>,
    idle: Notify,
}

#[derive(Default)]
struct State {
    stopped: bool,
    users: HashMap<u64, mpsc::Sender<Job>>,
}

impl PerUserQueue {
    pub fn enqueue(&self, user: u64, job: impl Future<Output = ()> + Send + 'static) -> Result<()> {
        let mut state = self.inner.state.lock().expect("queue lock poisoned");
        if state.stopped {
            bail!("Бот перезапускается, попробуй через минуту.");
        }
        let sender = state.users.entry(user).or_insert_with(|| {
            let (sender, mut receiver) = mpsc::channel::<Job>(20);
            let inner = self.inner.clone();
            tokio::spawn(async move {
                while let Some(job) = receiver.recv().await {
                    if AssertUnwindSafe(job).catch_unwind().await.is_err() {
                        tracing::error!(user, "Queued job panicked");
                    }
                    let mut state = inner.state.lock().expect("queue lock poisoned");
                    if receiver.is_empty() {
                        state.users.remove(&user);
                        inner.idle.notify_waiters();
                        break;
                    }
                }
            });
            sender
        });
        sender
            .try_send(Box::pin(job))
            .map_err(|_| anyhow::anyhow!("Очередь заполнена: дождись текущих загрузок."))
    }

    pub fn stop(&self) {
        self.inner
            .state
            .lock()
            .expect("queue lock poisoned")
            .stopped = true;
    }

    pub async fn drain(&self) {
        loop {
            let notified = self.inner.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self
                .inner
                .state
                .lock()
                .expect("queue lock poisoned")
                .users
                .is_empty()
            {
                return;
            }
            notified.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        sync::oneshot,
        time::{Duration, timeout},
    };

    #[tokio::test]
    async fn keeps_fifo_without_blocking_other_users_and_drains() {
        let queue = PerUserQueue::default();
        let (release, wait) = oneshot::channel();
        let (out, mut received) = mpsc::unbounded_channel();
        let first = out.clone();
        queue
            .enqueue(1, async move {
                wait.await.unwrap();
                first.send(1).unwrap();
            })
            .unwrap();
        let second = out.clone();
        queue
            .enqueue(1, async move {
                second.send(2).unwrap();
            })
            .unwrap();
        queue
            .enqueue(2, async move {
                out.send(3).unwrap();
            })
            .unwrap();
        assert_eq!(
            timeout(Duration::from_secs(1), received.recv())
                .await
                .unwrap(),
            Some(3)
        );
        release.send(()).unwrap();
        queue.stop();
        assert!(queue.enqueue(3, async {}).is_err());
        timeout(Duration::from_secs(1), queue.drain())
            .await
            .unwrap();
        assert_eq!(received.recv().await, Some(1));
        assert_eq!(received.recv().await, Some(2));
        assert!(queue.inner.state.lock().unwrap().users.is_empty());
    }

    #[tokio::test]
    async fn panic_does_not_break_the_next_job() {
        let queue = PerUserQueue::default();
        queue.enqueue(1, async { panic!("test failure") }).unwrap();
        let (sent, received) = oneshot::channel();
        queue
            .enqueue(1, async move {
                sent.send(()).unwrap();
            })
            .unwrap();
        timeout(Duration::from_secs(1), received)
            .await
            .unwrap()
            .unwrap();
        queue.drain().await;
    }
}
