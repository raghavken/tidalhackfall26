`timescale 1ns/1ps
module tb_station_demux;
reg clk=0,reset_n=0,sv=0,err=0;
reg [1:0] sid=0; reg [15:0] idx=0; reg signed [15:0] x=0;
wire accept, fault;
always #5 clk=~clk;
station_demux dut(clk,reset_n,sid,idx,x,sv,err,accept,fault);
task reset; begin @(negedge clk); reset_n=0; sv=0; @(negedge clk); reset_n=1; end endtask
task put; input [1:0] s; input [15:0] n; begin
 @(negedge clk); sv=1; sid=s; idx=n; x=17;
 @(negedge clk); sv=0;
end endtask
initial begin
 reset; put(0,0); put(1,0); put(2,0); put(3,0);
 if(fault || dut.accepted_count[0]!=1 || dut.latest_mhz[3]!=17) $fatal(1,"FAIL demux state");
 put(1,1); if(!fault) $fatal(1,"FAIL missing"); put(0,1);
 if(dut.accepted_count[0]!=1) $fatal(1,"FAIL latch");
 reset; put(0,0); put(0,0); if(!fault) $fatal(1,"FAIL duplicate");
 reset; put(0,1); if(!fault) $fatal(1,"FAIL initial index");
 reset; err=1; @(negedge clk); err=0; if(!fault) $fatal(1,"FAIL input error");
 reset; if(fault || dut.accepted_count[0]!=0) $fatal(1,"FAIL reset");
 $display("PASS station routing, ordering, loss, duplicate, reset"); $finish;
end
endmodule
