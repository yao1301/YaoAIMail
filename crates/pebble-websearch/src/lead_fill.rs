//! Delivery targets, not a promise that search engines contain twenty matches.
#[derive(Clone,Debug,PartialEq,Eq)]
pub enum FillStop { TargetReached, TimeLimit, NoProgress, SourceExhausted, ServiceError }
impl FillStop {pub fn code(&self)->&'static str {match self {
    Self::TargetReached=>"target_reached",Self::TimeLimit=>"time_limit",Self::NoProgress=>"no_progress",
    Self::SourceExhausted=>"source_exhausted",Self::ServiceError=>"service_error",
}}}
#[derive(Default)]
pub struct FillTracker {pub rounds:usize,stalled:usize,previous:usize}
impl FillTracker {
    pub fn new_round(&mut self,accepted:usize){
        if self.rounds>0 {if accepted>self.previous{self.stalled=0}else{self.stalled+=1;}}
        self.previous=accepted;self.rounds+=1;
    }
    pub fn stop(&self,accepted:usize,target:usize,timed_out:bool,fatal:bool)->Option<FillStop>{
        if accepted>=target {Some(FillStop::TargetReached)}
        else if fatal {Some(FillStop::ServiceError)}
        else if timed_out {Some(FillStop::TimeLimit)}
        else if self.stalled>=3 {Some(FillStop::NoProgress)}
        else if self.rounds>=8 {Some(FillStop::SourceExhausted)}else{None}
    }
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn small_partial_batches_continue_until_twenty(){
        let mut f=FillTracker::default();let mut count=0;
        for n in [2,3,4,5,6]{f.new_round(count);assert_eq!(f.stop(count,20,false,false),None);count+=n;}
        assert_eq!(f.stop(count,20,false,false),Some(FillStop::TargetReached));
    }
    #[test]fn bounded_stall_does_not_invent_customers(){let mut f=FillTracker::default();for _ in 0..4{f.new_round(2);}assert_eq!(f.stop(2,20,false,false),Some(FillStop::NoProgress));}
    #[test]fn partial_is_not_full_and_timeout_is_explicit(){assert_eq!(FillTracker::default().stop(3,20,true,false),Some(FillStop::TimeLimit));}
    #[test]fn positive_progress_resets_stall(){let mut f=FillTracker::default();for n in [0,0,1,1,2,3]{f.new_round(n);}assert_eq!(f.stop(4,20,false,false),None);}
}
